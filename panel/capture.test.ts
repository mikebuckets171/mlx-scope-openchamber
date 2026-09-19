import { expect, test } from 'bun:test';
import { PerformanceCapture, capturedRate } from './capture.ts';
import { parseTelemetrySnapshot, unavailableTelemetry } from '../src/telemetry.ts';
import type { AvailableTelemetry } from '../src/telemetry.ts';
const frame = (ms: number, tokens = ms / 50) => parseTelemetrySnapshot({ available: true, runtime: 'omlx', phase: 'decode', sampledAt: 1_800_000_000_000 + ms, modelID: 'private/model', activeRequests: 1, traceEpoch: 2, completionTokens: tokens, liveDecodeTPS: 999, memory: {activeGB: 20}, system: {platform:'macOS', cpuPercent:12, sampledAt:1_800_000_000_000+ms, memoryTotalGB:48, memoryUsedGB:30, macOS:{swapUsedGB:1,sampledAt:1_800_000_000_000+ms}} }) as AvailableTelemetry;

test('capture records existing intervals, not request averages, and finishes at its bounded window', () => {
  let clock = 0; const c = new PerformanceCapture(() => clock);
  expect(c.start(frame(0, 0), 30)).toBe(true);
  for (clock=500;clock<=30_000;clock+=500) c.observe(frame(clock));
  expect(c.current?.status).toBe('finished'); expect(c.current?.samples).toBe(61);
  expect(capturedRate(c.current)).toBe(20); expect(c.current?.peakProcessGB).toBe(20);
  expect(c.current?.peakCPU).toBe(12); expect(c.current?.startSwapGB).toBe(1);
  const last = structuredClone(c.current); c.observe(frame(40_000)); expect(c.current).toEqual(last);
});
test('capture cannot start idle, without attribution, or concurrently; never starts twice', () => {
  const c = new PerformanceCapture(() => 0);
  expect(c.start(unavailableTelemetry('runtime_unreachable'),30)).toBe(false);
  expect(c.start({...frame(0), activeRequests:2},30)).toBe(false);
  expect(c.start({...frame(0), phase:'idle'},30)).toBe(false);
  expect(c.start({...frame(0), modelID:null},30)).toBe(false);
  expect(c.start(frame(0),30)).toBe(true); expect(c.start(frame(0),30)).toBe(false);
});
test('capture de-duplicates cached snapshots and breaks counters at request changes', () => {
  let now=0; const c=new PerformanceCapture(()=>now); c.start(frame(0,100),30);
  now=1000;c.observe(frame(0,100));expect(c.current?.samples).toBe(1);
  c.observe(frame(1000,120));now=2000;c.observe({...frame(2000,90000),traceEpoch:3});
  now=3000;c.observe({...frame(3000,90020),traceEpoch:3});
  now=4000;c.observe({...frame(4000,90040),traceEpoch:3});
  expect(c.current?.decodeTokens).toBe(40);expect(capturedRate(c.current)).toBe(20);
});
test('pause, unavailable runtime, clock reversal and long gaps produce partial records', () => {
  for (const kind of ['pause','offline','gap','clock','model']) {
    let now=0;const c=new PerformanceCapture(()=>now);c.start(frame(0),60);
    if(kind==='pause') c.stop('Monitoring interrupted');
    if(kind==='offline') c.observe(unavailableTelemetry('runtime_unreachable'));
    if(kind==='gap'){now=13000;c.observe(frame(now));}
    if(kind==='clock'){now=-1;c.observe(frame(500));}
    if(kind==='model'){now=500;c.observe({...frame(500),modelID:'other'});}
    expect(c.current?.status).toBe('interrupted');expect(c.recording).toBe(false);
  }
});
test('two bounded summaries compare observed generation only and redact identity from reports', () => {
  let now=0;const c=new PerformanceCapture(()=>now);c.start(frame(0),30);
  for(now=1000;now<=6000;now+=1000)c.observe(frame(now));c.stop();expect(c.pin()).toBe(true);
  now=10000;c.start(frame(10000,0),30);
  for(now=11000;now<=16000;now+=1000)c.observe(frame(now,(now-10000)/40));c.stop();
  expect(c.comparison()).toBeCloseTo(25);
  const report=c.report('1.0.0');expect(report).not.toContain('private/model');expect(report).toContain('partial');
  expect(report).not.toContain('traceEpoch');expect(report).toContain('not selected-chat');
  c.clear();expect(c.current).toBeNull();expect(c.baseline).toBeNull();
});

test('large cumulative counters preserve small deltas without rounding loss', () => {
  let now = 0; const c = new PerformanceCapture(() => now);
  c.start(frame(0, Number.MAX_SAFE_INTEGER - 10), 30);
  now = 1000; c.observe(frame(now, Number.MAX_SAFE_INTEGER - 9));
  now = 2000; c.observe(frame(now, Number.MAX_SAFE_INTEGER - 8));
  now = 3000; c.observe(frame(now, Number.MAX_SAFE_INTEGER - 7));
  expect(c.current?.decodeTokens).toBe(2); expect(capturedRate(c.current)).toBe(1);
});
test('repeated cached samples cannot leave a capture running beyond its window', () => {
  let now = 0; const c = new PerformanceCapture(() => now); c.start(frame(0), 30);
  for (now = 1000; now <= 31_000; now += 1000) c.observe(frame(0));
  expect(c.current?.status).toBe('interrupted'); expect(c.current?.samples).toBe(1);
  expect(c.current?.note).toContain('No fresh'); expect(capturedRate(c.current)).toBeNull();
});

test('resource means use distinct host samples, with independent missing-value coverage', () => {
  let now = 0; const c = new PerformanceCapture(() => now);
  const initial = frame(0);
  c.start(initial, 30);
  now = 500;
  c.observe({ ...frame(now), system: { ...initial.system!, cpuPercent: 99, memoryUsedGB: 47 } });
  expect(c.current?.cpuSamples).toBe(1);
  expect(c.current?.meanCPU).toBe(12);
  expect(c.current?.meanMemoryGB).toBe(30);
  now = 2_000;
  const second = frame(now);
  c.observe({ ...second, memory: { ...second.memory!, activeGB: 24 },
    system: { ...second.system!, cpuPercent: 40, memoryUsedGB: 34 } });
  now = 3_000;
  c.observe({ ...frame(now), system: { ...frame(now).system!, cpuPercent: null, memoryUsedGB: 36 } });
  expect(c.current?.cpuSamples).toBe(2);
  expect(c.current?.meanCPU).toBe(26);
  expect(c.current?.peakCPU).toBe(40);
  expect(c.current?.memorySamples).toBe(3);
  expect(c.current?.meanMemoryGB).toBeCloseTo(100 / 3);
  expect(c.current?.peakMemoryGB).toBe(36);
  expect(c.current?.peakProcessGB).toBe(24);
  expect(c.current?.processSamples).toBe(4);
});

test('fresh system observations survive a cached runtime snapshot without duplicating output', () => {
  let now = 0; const c = new PerformanceCapture(() => now); const initial = frame(0);
  c.start(initial, 30);
  now = 2_000;
  c.observe({ ...initial, system: frame(now).system });
  expect(c.current?.samples).toBe(1);
  expect(c.current?.cpuSamples).toBe(2);
  expect(c.current?.memorySamples).toBe(2);
  expect(c.current?.seconds).toBe(2);
  expect(c.current?.decodeSeconds).toBe(0);
  expect(c.current?.lastAt).toBe(frame(now).sampledAt);
  c.stop(); expect(c.pin()).toBe(true);
  expect(capturedRate(c.baseline)).toBeNull();
});

test('cached native memory readings and pre-window host samples do not become fresh measurements', () => {
  let now = 0; const c = new PerformanceCapture(() => now);
  c.start({ ...frame(2_000), system: frame(0).system }, 30);
  expect(c.current?.cpuSamples).toBe(0);
  expect(c.current?.meanMemoryGB).toBeNull();
  expect(c.current?.startSwapGB).toBeNull();
  now = 1_000; const fresh = frame(3_000);
  c.observe(fresh);
  expect(c.current?.startSwapGB).toBe(1);
  now = 2_000; const next = frame(4_000);
  c.observe({ ...next, system: { ...next.system!, macOS: { ...fresh.system!.macOS!, swapUsedGB: 9 } } });
  expect(c.current?.lastSwapGB).toBe(1);
});

test('missing resource values remain unavailable and cannot be pinned as measured zeros', () => {
  let now = 0; const c = new PerformanceCapture(() => now);
  const missing = (ms: number): AvailableTelemetry => ({ ...frame(ms), phase: 'prefill', memory: null, system: null });
  c.start(missing(0), 30); now = 2_000; c.observe(missing(now)); c.stop();
  expect(c.current?.meanCPU).toBeNull(); expect(c.current?.peakCPU).toBeNull();
  expect(c.current?.meanMemoryGB).toBeNull(); expect(c.current?.peakMemoryGB).toBeNull();
  expect(c.current?.peakProcessGB).toBeNull(); expect(c.current?.requestCountChange).toBeNull();
  expect(c.pin()).toBe(false); expect(c.report('1.0.0')).toContain('mean not reported');
});

test('fresh zero-output intervals count toward rate while idle, prefill and processing break continuity', () => {
  let now = 0; const c = new PerformanceCapture(() => now); c.start(frame(0, 0), 30);
  now = 1_000; c.observe(frame(now, 0));
  now = 2_000; c.observe(frame(now, 20));
  now = 3_000; c.observe(frame(now, 20));
  expect(capturedRate(c.current)).toBe(10);
  for (const phase of ['idle', 'prefill', 'processing'] as const) {
    now += 1_000; c.observe({ ...frame(now, 20), phase });
  }
  now = 7_000; c.observe(frame(now, 1_000));
  now = 8_000; c.observe(frame(now, 1_020));
  expect(c.current?.decodeTokens).toBe(40);
  expect(c.current?.decodeSeconds).toBe(3);
  expect(capturedRate(c.current)).toBeCloseTo(40 / 3);
});

test('DFlash output counters are observed without borrowing the runtime request-average rate', () => {
  let now = 0; const c = new PerformanceCapture(() => now);
  c.start({ ...frame(0, 0), phase: 'processing', liveDecodeTPS: null }, 30);
  now = 1_000; c.observe({ ...frame(now, 10), liveDecodeTPS: null });
  now = 2_000; c.observe({ ...frame(now, 35), liveDecodeTPS: null });
  now = 3_000; c.observe({ ...frame(now, 60), liveDecodeTPS: null });
  expect(c.current?.decodeTokens).toBe(50);
  expect(capturedRate(c.current)).toBe(25);
});

const requestsFrame = (ms: number, requestsTotal: number | null): AvailableTelemetry => ({
  ...frame(ms), sessionStatsState: 'fresh', lifetime: {
    requestsTotal, uptimeSeconds: 100 + ms / 1000,
    promptTokensTotal: null, completionTokensTotal: null, cachedTokensTotal: null,
  },
});

test('request count changes require fresh monotonic reported totals across the observation', () => {
  let now = 0; const c = new PerformanceCapture(() => now);
  c.start(requestsFrame(0, 100), 30);
  expect(c.current?.requestCountChange).toBeNull();
  now = 1_000; c.observe(requestsFrame(now, 100));
  expect(c.current?.requestCountChange).toBe(0);
  now = 2_000; c.observe(requestsFrame(now, 103));
  expect(c.current?.requestCountChange).toBe(3);
  expect(c.report('1.0.0')).toContain('Reported server request count change: 3.');
  for (const failure of ['stale', 'missing', 'rollback', 'restart'] as const) {
    now = 0; const capture = new PerformanceCapture(() => now);
    capture.start(requestsFrame(0, 100), 30);
    now = 1_000; capture.observe(requestsFrame(now, 101));
    now = 2_000; const changed = requestsFrame(now, failure === 'missing' ? null : failure === 'rollback' ? 2 : 102);
    if (failure === 'stale') changed.sessionStatsState = 'stale';
    if (failure === 'restart') changed.lifetime!.uptimeSeconds = 1;
    capture.observe(changed);
    now = 3_000; capture.observe(requestsFrame(now, 103));
    expect(capture.current?.requestCountChange).toBeNull();
  }
});

test('late observations cannot extend the capture or fabricate deadline coverage', () => {
  let now = 0; const c = new PerformanceCapture(() => now); c.start(requestsFrame(0, 100), 30);
  for (now = 1_000; now <= 29_000; now += 1_000) c.observe(requestsFrame(now, 100));
  now = 31_000; const late = requestsFrame(now, 1_000);
  c.observe({ ...late, memory: { ...late.memory!, activeGB: 1_000 },
    system: { ...late.system!, cpuPercent: 100, memoryUsedGB: 48 } });
  expect(c.current?.status).toBe('finished');
  expect(c.current?.seconds).toBe(29);
  expect(c.current?.decodeSeconds).toBe(28);
  expect(c.current?.samples).toBe(30);
  expect(c.current?.peakProcessGB).toBe(20);
  expect(c.current?.peakCPU).toBe(12);
  expect(c.current?.requestCountChange).toBe(0);
  expect(c.current?.note).toContain('29.0s observed');
});

test('the latest pre-click sample cannot contribute a rate interval to the observation', () => {
  let now = 0; const c = new PerformanceCapture(() => now);
  c.start(frame(0, 1_000), 30);
  now = 100; c.observe(frame(500, 1_010));
  expect(c.current?.decodeTokens).toBe(0);
  expect(c.current?.decodeSeconds).toBe(0);
  now = 600; c.observe(frame(1_000, 1_020));
  expect(c.current?.decodeTokens).toBe(10);
  expect(c.current?.decodeSeconds).toBe(0.5);
  expect(c.current!.decodeSeconds).toBeLessThanOrEqual(c.current!.seconds);
});
