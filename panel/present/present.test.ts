import { expect, test } from 'bun:test';
import { hostStates } from '../../src/contract/testing/v1-states.ts';
import type { RecentSpeed } from '../insights.ts';
import { completionOf, fromService } from '../testing/readings.ts';
import { presentCapture, presentGeneration, savedValue } from './captures.ts';
import { age, count, gibText, rate, uptime } from './format.ts';
import { presentGlance } from './glance.ts';
import { presentHeader } from './header.ts';
import { presentHost, presentLive, presentProgress, presentRecent } from './live.ts';
import { frameReading, type Reading } from './reading.ts';
import { derive, type Scope } from './scope.ts';
import { presentInsights, presentServer } from './server.ts';

// Presenter strings per runtime, on the synthetic host's fixtures converted to v2. The 1.6 goldens hold the same
// strings; these tests pin them next to the presenters.
const states = hostStates();
const readingOf = (name: string): Reading => fromService(states.find(state => state.name === `host ${name} #0`)!.body);
const scopeOf = (name: string, options: { speed?: RecentSpeed; last?: Reading | null; reading?: Reading } = {}): Scope => {
  const reading = options.reading ?? readingOf(name);
  const last = options.last !== undefined ? options.last : reading.available ? reading : null;
  return derive({ reading, last, host: reading.host ?? last?.host ?? null, lastRequest: completionOf(reading), selectionRuntime: null,
    speed: options.speed ?? null, now: reading.sampledAt });
};
const all = (scope: Scope) => ({ header: presentHeader(scope), live: presentLive(scope), server: presentServer(scope),
  insights: presentInsights(scope.reading, scope.lastRequest) });

test('format: GiB from integer bytes reproduces the 1.6 strings made from decimal GB', () => {
  for (const [gb, text] of [[17.1, '15.9 GiB'], [34.5, '32.1 GiB'], [12.5, '11.6 GiB'], [13, '12.1 GiB'], [22.4, '20.9 GiB'], [3.2, '3 GiB']] as const) {
    expect(gibText(Math.round(gb * 1e9))).toBe(text);
  }
  expect(gibText(Math.round(1.1 * 1024 ** 3))).toBe('1.1 GiB');
  expect([gibText(null), count(52_100), rate(24.6), age(0, 2_999), age(0, 3_000), age(0, 61_000), uptime(51_420_000)])
    .toEqual(['—', '52.1K', '24.6 tok/s', 'Updated now', 'Updated 3s ago', 'Updated 1m ago', '14h 17m · since start']);
});

test('oMLX decode: request averages, token reuse and server-wide memory', () => {
  const { header, live, server, insights } = all(scopeOf('omlx-decode'));
  expect([header.phase, header.connection, header.model, header.activityLabel, header.freshness]).toEqual(['Generating', 'oMLX connected', 'Qwen3.8-27B-4bit', 'MODEL ACTIVITY', 'Updated now']);
  expect([live.rate, live.unit, live.activityHidden, live.signalHidden]).toEqual(['25.1', 'tokens / second · request average', true, false]);
  expect(live.metrics).toMatchObject({ reuse: '83%', reuseDetail: '43K tokens', requests: '1', queue: 'Queue clear', output: '6.5K', elapsed: '260.5s' });
  expect(live.headroom).toMatchObject({ remaining: '72.5K tokens to model limit', accounted: '45% accounted · prompt + output' });
  expect(live.host.card).toMatchObject({ title: 'macOS host', ram: '36.1 / 48 GiB', swap: '1.1 GiB', wired: '4.5 GiB', compressed: '2.8 GiB' });
  expect(server.memory).toMatchObject({ title: 'Runtime memory', processLabel: 'oMLX process footprint', process: '32.1 GiB', model: '15.9 GiB', source: 'oMLX · server-wide' });
  expect(server.session).toMatchObject({ title: 'Server session', values: ['23.2 tok/s', '184.5 tok/s', '82%'], uptime: '14h 17m · since start' });
  expect(server.details).toMatchObject({ hidden: false, ssdCache: '20.9 GiB', guard: 'Normal', lookup: 'closest recent store' });
  expect(insights.cache).toMatchObject({ reused: '43,000', fresh: '9,100', requestState: '82.5% of input reused', ram: '3 GiB', ssd: '20.9 GiB' });
  expect(insights.residents.rows).toEqual([{ phase: 'decode', name: 'Qwen3.8-27B-4bit', title: 'Qwen3.8-27B-4bit', label: 'Generating', reading: '24.6 tok/s', allocation: '15.9 GiB allocated' }]);
});

test('oMLX prefill: stage progress, the runtime estimate, and a held reading', () => {
  const scope = scopeOf('omlx-prefill');
  const { header, live } = all(scope);
  expect([header.phase, live.rate, live.unit, live.metrics.context]).toEqual(['Reading context', '184.5', 'prefill tokens / second', '40%']);
  expect(presentProgress(scope.current)).toEqual({ remaining: '36% remaining', completed: '64% complete', state: 'Live reading', held: false, percent: 64,
    valueNow: '64', valueText: '36% remaining; 64% complete', counts: '5,824 / 9,100 tokens processed · 3,276 left' });
  expect(presentProgress(scope.current, 'paused')).toMatchObject({ state: 'Paused · last reading', held: true, valueText: '36% remaining; 64% complete; last reading, not live' });
  expect(presentRecent(scope.reading, null)).toMatchObject({ estimateHidden: false, estimate: '~20s' });
  expect(live.estimateSource).toBe('oMLX estimate · may change');
});

test('oMLX offline, credentials and concurrency keep their 1.6 wording', () => {
  const offline = all(scopeOf('omlx-offline'));
  expect([offline.header.phase, offline.header.connection, offline.header.connectionMessage, offline.header.diagnosisHidden, offline.header.freshness])
    .toEqual(['Connecting', 'Waiting for Local runtime', 'oMLX is not responding. Start the server, then refresh.', false, 'No sample yet']);
  expect([offline.live.rate, offline.live.host.hidden, offline.live.host.card?.swap]).toEqual(['—', false, '1.1 GiB']);
  expect(all(scopeOf('omlx-auth')).header).toMatchObject({ phase: 'Offline', connection: 'Authentication required' });
  const multi = all(scopeOf('omlx-multi'));
  expect([multi.header.phase, multi.live.rate, multi.live.activity]).toEqual(['Processing', '—', 'Concurrent requests or models · per-request values withheld']);
  expect(multi.insights.residents.rows.map(row => row.reading)).toEqual(['24.6 tok/s', '77% left']);
  expect(all(scopeOf('omlx-not-loaded')).live).toMatchObject({ rate: 'Standby', unit: 'Load a model in oMLX' });
});

test('a lost runtime keeps its last reading, labelled as not live', () => {
  const live = readingOf('omlx-decode'), lost = frameReading('runtime_unreachable', 'No fresh observations. Retained readings are not live.', live.sampledAt + 12_000);
  const { header, live: view, server } = all(scopeOf('omlx-decode', { reading: lost, last: live }));
  expect([header.phase, header.connection, header.model, header.notice, header.freshness])
    .toEqual(['Reconnecting', 'Waiting for oMLX', 'Qwen3.8-27B-4bit', 'Updated 12s ago. Retained details are not live.', 'Updated 12s ago']);
  expect([view.rate, view.unit, view.activity]).toEqual(['—', 'No fresh throughput', 'No fresh observations. Retained readings are not live.']);
  expect(server.memory).toMatchObject({ stale: true, source: 'Last reading · not live', process: '32.1 GiB' });
  expect(presentHost(null, live.host, lost.sampledAt)).toMatchObject({ stale: true, card: { freshness: 'Last reading · not live', cpu: '—', swap: '—' } });
});

test('DFlash output is labelled as observed, never as a request average', () => {
  const view = presentLive(scopeOf('dflash-preparing', { speed: { tokensPerSecond: 32, seconds: 2 } }));
  expect([view.rate, view.activity, view.requestOutputHidden]).toEqual(['—', 'Working · this engine does not report prefill percentage', true]);
});

test('standalone Splash: one server-wide decode speed, Metal memory, and a loading state', () => {
  const { header, live, server, insights } = all(scopeOf('splash-ready'));
  expect([header.phase, header.connection, header.model, header.splashDetail, header.coverageNoteHidden])
    .toEqual(['Idle', 'Splash (standalone) connected', 'Qwen3.8-27B-Splash', '262,144-token context', true]);
  expect([live.rate, live.unit, live.activity]).toEqual(['47.2', 'tok/s · server decode, all requests', 'Idle · ready for your next request.']);
  expect(server.memory).toMatchObject({ title: 'GPU memory (Metal)', processLabel: 'Now', modelLabel: 'Peak', process: '11.6 GiB', model: '12.1 GiB' });
  expect(server.session).toMatchObject({ title: 'Requests', labels: ['Server decode', 'Completed', 'Failed'], values: ['47.2 tok/s', '17', '1'], warn: true,
    state: 'Server decode is shared across all requests.', uptime: 'Since Splash started' });
  expect([insights.catalog.hidden, insights.cache.hidden]).toEqual([true, true]);
  const loading = all(scopeOf('splash-loading'));
  expect([loading.header.connection, loading.header.phase, loading.live.rate, loading.live.unit, loading.live.activityHidden])
    .toEqual(['Splash (standalone) · loading model', 'Loading', 'Loading', 'Splash is loading the model', true]);
});

test('Splash via Bionic: exact figures from the last finished response', () => {
  const decode = all(scopeOf('bionic-decode'));
  expect([decode.header.connection, decode.live.rate, decode.live.unit, decode.live.signalHidden])
    .toEqual(['Splash via Bionic connected', 'Generating', 'Exact speed when it finishes · last 38.6 tok/s', true]);
  expect(decode.live.metrics).toMatchObject({ context: '7%', contextDetail: '18.4K / 262.1K · last response', reuse: '61%', reuseDetail: '11.3K tokens · last response', queue: 'running now' });
  expect(decode.server.session).toMatchObject({ title: 'Finished responses', labels: ['Decode average', 'Last first token', 'Input reused'], values: ['37.9 tok/s', '0.5s', '61%'], uptime: 'This session' });
  expect(decode.insights.catalog).toMatchObject({ hidden: false, title: 'Splash models', count: '5 Splash · 1 loaded' });
  expect(decode.insights.cache).toMatchObject({ scope: 'Last response', requestState: '61.2% of input reused · last response' });
  const idle = all(scopeOf('bionic-idle'));
  expect([idle.live.rate, idle.live.unit]).toEqual(['38.6', 'tok/s · last response (exact) · finished 42s ago']);
  expect(all(scopeOf('bionic-none')).header).toMatchObject({ connection: 'Splash via Bionic connected · no model loaded', model: 'No model loaded' });
  expect(all(scopeOf('bionic-none')).live.activity).toBe('Load a Splash model in Bionic to start. Activity appears here as soon as it serves a request.');
});

test('inventory runtimes: LM Studio, mlx-lm and vllm-mlx say what they can and cannot report', () => {
  const studio = all(scopeOf('lmstudio-inventory'));
  expect([studio.header.phase, studio.header.connection, studio.header.model, studio.header.activityLabel, studio.header.coverageNote])
    .toEqual(['Connected', 'LM Studio connected', 'LM Studio', 'LOCAL RUNTIME', 'LM Studio lists its models here. Live request activity appears when its local log stream is available.']);
  expect(studio.insights.catalog).toMatchObject({ hidden: false, title: 'Model inventory', count: '2 reported' });
  expect(studio.insights.catalog.rows[0]).toEqual({ name: 'Local model', loaded: true, state: 'Loaded', format: 'mlx', formatLabel: 'MLX', context: '32,768 context' });
  expect(all(scopeOf('mlx-lm-inventory')).insights.catalog).toMatchObject({ title: 'Available models', rows: [{ state: '', context: '' }] });
  expect(all(scopeOf('vllm-inventory')).header.coverageNote).toBe('vllm-mlx is reachable. It does not report live request progress.');
  const vllm = all(scopeOf('vllm-mlx-live'));
  expect([vllm.header.connection, vllm.live.estimateSource, vllm.server.memory.processLabel]).toEqual(['vllm-mlx connected', 'vllm-mlx estimate · may change', 'vllm-mlx process footprint']);
});

test('setup problems point at the connection, never at the runtime', () => {
  const missing = all(scopeOf('setup-missing'));
  expect([missing.header.connection, missing.header.instrumentHidden, missing.header.connectionMessage])
    .toEqual(['Waiting for oMLX', true, 'No local OpenCode connection was found. Add a local provider, then refresh.']);
  expect(all(scopeOf('custom-needs-runtime')).header.connectionMessage).toBe('Select a runtime for this custom connection.');
});

test('captures, recent generations and saved values format bytes through the one GiB formatter', () => {
  const capture = { model: 'm', targetSeconds: 30 as const, startedAt: 0, lastAt: 1, seconds: 12.34, samples: 25, decodeSeconds: 10, decodeTokens: 250,
    peakProcessBytes: 34.5e9, processSamples: 3, meanCPU: 28.44, peakCPU: 35.1, cpuSamples: 6, meanMemoryBytes: Math.round(36.1 * 1024 ** 3),
    peakMemoryBytes: 48 * 1024 ** 3, memorySamples: 6, requestCountChange: 2, startSwapBytes: null, lastSwapBytes: null, status: 'finished' as const, note: 'n' };
  expect(presentCapture(capture, null, false, null)).toMatchObject({ state: 'Captured', speed: '25.0 tok/s', memory: '32.1 GiB', cpu: '28.4 / 35.1 %',
    hostMemory: '36.1 / 48.0 GiB', requests: '2', duration: '12.3s', change: 'Different observation' });
  expect(presentGeneration({ sequence: 1, model: 'org/model', epoch: 1, firstSeenAt: 0, lastSeenAt: 0, outputTokens: 1_234, averageTPS: 24,
    elapsedMs: 1_000, promptTokens: null, cachedTokens: null, peakProcessBytes: 34.5e9, coverage: 'monitoring-gap' }))
    .toMatchObject({ name: 'model', speed: '24 tok/s', tokens: '1,234 tokens last seen', note: 'Monitoring gap · 32.1 GiB peak observed footprint' });
  expect([savedValue('prefillRemaining', 0.4), savedValue('memory', 36.10000000037253), savedValue('cpu', null)]).toEqual(['<1', '36.1', '—']);
});

test('the Work Status glance stub reads the same reading', () => {
  expect(presentGlance(readingOf('omlx-prefill'))).toEqual({ phase: 'Reading context', model: 'Qwen3.8-27B-4bit', rate: '184.5 tok/s prefill' });
  expect(presentGlance(readingOf('omlx-offline'))).toEqual({ phase: 'Waiting for Local runtime', model: null, rate: null });
});
