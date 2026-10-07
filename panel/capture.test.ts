import { expect, test } from 'bun:test';
import { PerformanceCapture, capturedRate } from './capture.ts';
import { frameReading, type Reading } from './present/reading.ts';
import { fromV1 } from './testing/readings.ts';
const GB = 1e9;
const frame = (ms: number, tokens = ms / 50, extra: Record<string, unknown> = {}) => fromV1({ available: true, runtime: 'omlx', phase: 'decode', sampledAt: 1_800_000_000_000 + ms, modelID: 'private/model', activeRequests: 1, traceEpoch: 2, completionTokens: tokens, liveDecodeTPS: 999, memory: {activeGB: 20}, system: {platform:'macOS', cpuPercent:12, sampledAt:1_800_000_000_000+ms, memoryTotalGB:48, memoryUsedGB:30, macOS:{swapUsedGB:1,sampledAt:1_800_000_000_000+ms}}, ...extra });
const offline = () => frameReading('runtime_unreachable', null, Date.now());

test('capture records existing intervals, not request averages, and finishes at its bounded window', () => {
  let clock = 0; const c = new PerformanceCapture(() => clock);
  expect(c.start(frame(0, 0), 30)).toBe(true);
  for (clock=500;clock<=30_000;clock+=500) c.observe(frame(clock));
  expect(c.current?.status).toBe('finished'); expect(c.current?.samples).toBe(61);
  expect(capturedRate(c.current)).toBe(20); expect(c.current?.peakProcessBytes).toBe(20 * GB);
  expect(c.current?.peakCPU).toBe(12); expect(c.current?.startSwapBytes).toBe(1 * GB);
  const last = structuredClone(c.current); c.observe(frame(40_000)); expect(c.current).toEqual(last);
});
test('capture cannot start idle, without attribution, or concurrently; never starts twice', () => {
  const c = new PerformanceCapture(() => 0);
  expect(c.start(offline(),30)).toBe(false);
  expect(c.start(frame(0, 0, {activeRequests:2}),30)).toBe(false);
  expect(c.start(frame(0, 0, {phase:'idle'}),30)).toBe(false);
  expect(c.start(frame(0, 0, {modelID:null}),30)).toBe(false);
  expect(c.start(frame(0),30)).toBe(true); expect(c.start(frame(0),30)).toBe(false);
});
test('capture de-duplicates cached snapshots and breaks counters at request changes', () => {
  let now=0; const c=new PerformanceCapture(()=>now); c.start(frame(0,100),30);
  now=1000;c.observe(frame(0,100));expect(c.current?.samples).toBe(1);
  c.observe(frame(1000,120));now=2000;c.observe(frame(2000,90000,{traceEpoch:3}));
  now=3000;c.observe(frame(3000,90020,{traceEpoch:3}));
  now=4000;c.observe(frame(4000,90040,{traceEpoch:3}));
  expect(c.current?.decodeTokens).toBe(40);expect(capturedRate(c.current)).toBe(20);
});
test('pause, unavailable runtime, clock reversal and long gaps produce partial records', () => {
  for (const kind of ['pause','offline','gap','clock','model']) {
    let now=0;const c=new PerformanceCapture(()=>now);c.start(frame(0),60);
    if(kind==='pause') c.stop('Monitoring interrupted');
    if(kind==='offline') c.observe(offline());
    if(kind==='gap'){now=13000;c.observe(frame(now));}
    if(kind==='clock'){now=-1;c.observe(frame(500));}
    if(kind==='model'){now=500;c.observe(frame(500,10,{modelID:'other'}));}
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
  expect(report).not.toContain('traceEpoch');expect(report).toContain('all server activity');
  expect(report).toContain('average 27.94 GiB, peak 27.94 GiB');
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

const withHost = (reading: Reading, host: Partial<NonNullable<Reading['host']>>): Reading => ({ ...reading, host: { ...reading.host!, ...host } });
test('resource means use distinct host samples, with independent missing-value coverage', () => {
  let now = 0; const c = new PerformanceCapture(() => now);
  const initial = frame(0);
  c.start(initial, 30);
  now = 500;
  c.observe({ ...frame(now), host: { ...initial.host!, cpuPercent: 99, memUsedBytes: 47 * GB } });
  expect(c.current?.cpuSamples).toBe(1);
  expect(c.current?.meanCPU).toBe(12);
  expect(c.current?.meanMemoryBytes).toBe(30 * GB);
  now = 2_000;
  const second = frame(now);
  c.observe(withHost({ ...second, memory: { ...second.memory, processBytes: 24 * GB } }, { cpuPercent: 40, memUsedBytes: 34 * GB }));
  now = 3_000;
  c.observe(withHost(frame(now), { cpuPercent: null, memUsedBytes: 36 * GB }));
  expect(c.current?.cpuSamples).toBe(2);
  expect(c.current?.meanCPU).toBe(26);
  expect(c.current?.peakCPU).toBe(40);
  expect(c.current?.memorySamples).toBe(3);
  expect(c.current?.meanMemoryBytes).toBeCloseTo(100 / 3 * GB);
  expect(c.current?.peakMemoryBytes).toBe(36 * GB);
  expect(c.current?.peakProcessBytes).toBe(24 * GB);
  expect(c.current?.processSamples).toBe(4);
});

test('fresh system observations survive a cached runtime snapshot without duplicating output', () => {
  let now = 0; const c = new PerformanceCapture(() => now); const initial = frame(0);
  c.start(initial, 30);
  now = 2_000;
  c.observe({ ...initial, host: frame(now).host });
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
  c.start({ ...frame(2_000), host: frame(0).host }, 30);
  expect(c.current?.cpuSamples).toBe(0);
  expect(c.current?.meanMemoryBytes).toBeNull();
  expect(c.current?.startSwapBytes).toBeNull();
  now = 1_000; const fresh = frame(3_000);
  c.observe(fresh);
  expect(c.current?.startSwapBytes).toBe(1 * GB);
  now = 2_000; const next = frame(4_000);
  c.observe(withHost(next, { mac: { ...fresh.host!.mac!, swapUsedBytes: 9 * GB } }));
  expect(c.current?.lastSwapBytes).toBe(1 * GB);
});

test('missing resource values remain unavailable and cannot be pinned as measured zeros', () => {
  let now = 0; const c = new PerformanceCapture(() => now);
  const missing = (ms: number) => frame(ms, ms / 50, { phase: 'prefill', memory: null, system: null });
  c.start(missing(0), 30); now = 2_000; c.observe(missing(now)); c.stop();
  expect(c.current?.meanCPU).toBeNull(); expect(c.current?.peakCPU).toBeNull();
  expect(c.current?.meanMemoryBytes).toBeNull(); expect(c.current?.peakMemoryBytes).toBeNull();
  expect(c.current?.peakProcessBytes).toBeNull(); expect(c.current?.requestCountChange).toBeNull();
  expect(c.pin()).toBe(false); expect(c.report('1.0.0')).toContain('average not reported');
});

test('fresh zero-output intervals count toward rate while idle, prefill and processing break continuity', () => {
  let now = 0; const c = new PerformanceCapture(() => now); c.start(frame(0, 0), 30);
  now = 1_000; c.observe(frame(now, 0));
  now = 2_000; c.observe(frame(now, 20));
  now = 3_000; c.observe(frame(now, 20));
  expect(capturedRate(c.current)).toBe(10);
  for (const phase of ['idle', 'prefill', 'processing'] as const) {
    now += 1_000; c.observe(frame(now, 20, { phase }));
  }
  now = 7_000; c.observe(frame(now, 1_000));
  now = 8_000; c.observe(frame(now, 1_020));
  expect(c.current?.decodeTokens).toBe(40);
  expect(c.current?.decodeSeconds).toBe(3);
  expect(capturedRate(c.current)).toBeCloseTo(40 / 3);
});

test('DFlash output counters are observed without borrowing the server request-average rate', () => {
  let now = 0; const c = new PerformanceCapture(() => now);
  c.start(frame(0, 0, { phase: 'processing', liveDecodeTPS: null }), 30);
  now = 1_000; c.observe(frame(now, 10, { liveDecodeTPS: null }));
  now = 2_000; c.observe(frame(now, 35, { liveDecodeTPS: null }));
  now = 3_000; c.observe(frame(now, 60, { liveDecodeTPS: null }));
  expect(c.current?.decodeTokens).toBe(50);
  expect(capturedRate(c.current)).toBe(25);
});

const requestsFrame = (ms: number, requestsTotal: number | null, extra: Record<string, unknown> = {}) => frame(ms, ms / 50, {
  sessionStatsState: 'fresh', lifetime: { requestsTotal, uptimeSeconds: 100 + ms / 1000 }, ...extra,
});

test('request count changes require fresh monotonic reported totals across the observation', () => {
  let now = 0; const c = new PerformanceCapture(() => now);
  c.start(requestsFrame(0, 100), 30);
  expect(c.current?.requestCountChange).toBeNull();
  now = 1_000; c.observe(requestsFrame(now, 100));
  expect(c.current?.requestCountChange).toBe(0);
  now = 2_000; c.observe(requestsFrame(now, 103));
  expect(c.current?.requestCountChange).toBe(3);
  expect(c.report('1.0.0')).toContain('New finished requests: 3.');
  for (const failure of ['stale', 'missing', 'rollback', 'restart'] as const) {
    now = 0; const capture = new PerformanceCapture(() => now);
    capture.start(requestsFrame(0, 100), 30);
    now = 1_000; capture.observe(requestsFrame(now, 101));
    now = 2_000;
    capture.observe(requestsFrame(now, failure === 'missing' ? null : failure === 'rollback' ? 2 : 102, failure === 'stale' ? { sessionStatsState: 'stale' }
      : failure === 'restart' ? { lifetime: { requestsTotal: 102, uptimeSeconds: 1 } } : {}));
    now = 3_000; capture.observe(requestsFrame(now, 103));
    expect(capture.current?.requestCountChange).toBeNull();
  }
});

test('late observations cannot extend the capture or fabricate deadline coverage', () => {
  let now = 0; const c = new PerformanceCapture(() => now); c.start(requestsFrame(0, 100), 30);
  for (now = 1_000; now <= 29_000; now += 1_000) c.observe(requestsFrame(now, 100));
  now = 31_000; const late = requestsFrame(now, 1_000);
  c.observe(withHost({ ...late, memory: { ...late.memory, processBytes: 1_000 * GB } }, { cpuPercent: 100, memUsedBytes: 48 * GB }));
  expect(c.current?.status).toBe('finished');
  expect(c.current?.seconds).toBe(29);
  expect(c.current?.decodeSeconds).toBe(28);
  expect(c.current?.samples).toBe(30);
  expect(c.current?.peakProcessBytes).toBe(20 * GB);
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

test('inventory and registry observations capture host resources without output or model attribution', () => {
  for (const coverage of ['inventory', 'server'] as const) {
    let now = 0;
    const c = new PerformanceCapture(() => now);
    const sample = (ms: number, selected = 'local') => frame(ms, 0, { runtime: 'lmstudio', phase: 'unknown', modelID: null,
      activeRequests: null, completionTokens: null, memory: null, liveDecodeTPS: null,
      connection: { selected, label: 'Local', runtime: 'lmstudio', choices: [], diagnostic: 'ready', coverage } });
    expect(c.start(sample(0), 30)).toBe(true);
    for (now = 2000; now <= 30_000; now += 2000) c.observe(sample(now));
    expect(c.current?.status).toBe('finished');
    expect(c.current?.meanCPU).toBe(12);
    expect(c.current?.cpuSamples).toBe(16);
    expect(c.current?.peakProcessBytes).toBeNull();
    expect(capturedRate(c.current)).toBeNull();
    expect(c.pin()).toBe(true);
    now = 40_000; expect(c.start(sample(now), 30)).toBe(true);
    now += 2000; c.observe(sample(now, 'other'));
    expect(c.current?.status).toBe('interrupted');
  }
});

test('Splash captures use its Metal allocation and finished-request counters, but never invent output speed', () => {
  let now = 0, finished = 17;
  const c = new PerformanceCapture(() => now);
  const sample = (ms: number, metal: number) => frame(ms, 0, { runtime: 'splash', phase: 'idle', modelID: null,
    activeRequests: 0, completionTokens: null, memory: null, lifetime: null, sessionStatsState: 'unavailable', liveDecodeTPS: null,
    serverStats: { ready: true, aggregateDecodeTokensPerSecond: 47.2, completedRequests: finished, failedRequests: 1, metalCurrentGB: metal, metalPeakGB: 13 },
    connection: { selected: 'splash', label: 'Splash', runtime: 'splash', choices: [], diagnostic: 'ready', coverage: 'server' } });
  expect(c.start(sample(0, 12), 30)).toBe(true);
  for (now = 2000; now <= 30_000; now += 2000) { if (now === 10_000) finished += 3; c.observe(sample(now, now === 20_000 ? 12.8 : 12.1)); }
  expect(c.current?.status).toBe('finished');
  expect(c.current?.peakProcessBytes).toBe(12.8 * GB);
  expect(c.current?.requestCountChange).toBe(3);
  expect(capturedRate(c.current)).toBeNull();
});
