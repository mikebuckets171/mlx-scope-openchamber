import { expect, test } from 'bun:test';
import { normalizeOmlxTelemetry, parseTelemetrySnapshot, MAX_RESIDENT_MODELS } from '../src/telemetry.ts';
import { cacheSplit, prefillEstimate, SessionInsights, recentGenerationsReport, MAX_RECENT_GENERATIONS } from './insights.ts';
import { frameReading, type Reading } from './present/reading.ts';
import { fromV1 } from './testing/readings.ts';
const reading = (at: number, overrides: object = {}) => fromV1({ available: true, sampledAt: at, modelID: 'private-model', traceEpoch: 1, phase: 'decode',
  completionTokens: at / 1000 * 20, liveDecodeTPS: 20, activeRequests: 1, elapsedSeconds: at / 1000, ...overrides });
const activity = (models: object[]) => normalizeOmlxTelemetry(null, { active_models: { models } })!;
const request = (value: Reading, patch: Partial<NonNullable<Reading['request']>>): Reading => ({ ...value, request: { ...value.request!, ...patch } });

test('prefill ETA is a reported estimate, never a synthetic countdown or completion prediction', () => {
  const raw = activity([{ id: 'm', active_requests: 1, prefilling: [{ processed: 64, total: 100, speed: 10, eta: 3.6 }] }]);
  expect(raw.prefillETASeconds).toBe(3.6);
  const panel = fromV1(raw);
  expect(prefillEstimate(panel)).toBe('~5s');
  expect(parseTelemetrySnapshot(raw)).toEqual(raw);
  expect(prefillEstimate(request(panel, { prefillEtaMs: 125_000 }))).toBe('~3m');
  for (const value of [-1, Infinity, NaN, undefined]) expect(prefillEstimate(request(panel, { prefillEtaMs: value }))).toBeNull();
  for (const patch of [{ prefillStale: true }, { prefillFraction: 1 }, { prefillFraction: undefined }, { prefillTps: 0 }]) {
    expect(prefillEstimate(request(panel, patch))).toBeNull();
  }
  expect(prefillEstimate(request(panel, { prefillEtaMs: 100 }))).toBe('<1s');
  expect(prefillEstimate(reading(1000))).toBeNull();
});

test('raw and wire contracts withhold stale, ambiguous and invalid ETA data', () => {
  const flight = { processed: 50, total: 100, speed: 10, eta: 5 };
  for (const patch of [{ progress_stale: true }, { total: 0 }, { processed: 101 }, { speed: 0 }, { eta: '5' }]) {
    expect(activity([{ id: 'm', prefilling: [{ ...flight, ...patch }] }]).prefillETASeconds).toBeNull();
  }
  expect(activity([{ id: 'm', active_requests: 2, prefilling: [flight] }]).prefillETASeconds).toBeNull();
  expect(reading(1000, { phase: 'prefill', prefillProgress: .5, prefillETASeconds: 2, livePrefillTPS: 1, prefillProgressStale: true }).request?.prefillEtaMs).toBeUndefined();
});

test('resident model roster separates simultaneous models without aggregating speeds', () => {
  const result = activity([
    { id: 'one', active_requests: 1, actual_size: 10e9, generating: [{ request_id: 'PRIVATE_REQUEST', generated_tokens: 200, elapsed_seconds: 10, last_activity_age_seconds: 0, tokens_per_second: 20, prompt: 'PRIVATE_PROMPT' }] },
    { id: 'two', active_requests: 1, prefilling: [{ processed: 5, total: 10, speed: 30, eta: .2 }] },
  ]);
  expect(result.phase).toBe('processing'); expect(result.liveDecodeTPS).toBeNull();
  expect(result.residentModels).toMatchObject([{ id: 'one', tokensPerSecond: 20, allocationGB: 10 }, { id: 'two', prefillProgress: .5, tokensPerSecond: 30 }]);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(parseTelemetrySnapshot(result)).toEqual(result);
  expect(fromV1(result).residents).toMatchObject([{ model: 'one', tps: 20, bytes: 10e9 }, { model: 'two', prefillFraction: .5, tps: 30 }]);
});

test('model list is bounded and rejects raw request data, stale speeds and invalid measurements', () => {
  const result = activity(Array.from({ length: 100 }, (_, i) => ({ id: `model-${i}`, active_requests: 0 })));
  expect(result.residentModelCount).toBe(100); expect(result.residentModels).toHaveLength(MAX_RESIDENT_MODELS);
  const wire = reading(1000, { residentModels: [{ id: 'm'.repeat(1000), phase: 'prefill', tokensPerSecond: 100, prefillProgress: .5, progressStale: true, allocationGB: -1, prompt: 'PRIVATE' }] });
  expect(wire.residents[0]?.model).toHaveLength(256); expect(wire.residents[0]?.tps).toBeNull();
  expect(wire.residents[0]?.bytes).toBeNull(); expect(JSON.stringify(wire)).not.toContain('PRIVATE');
  expect(reading(1000).residents).toEqual([]);
});

test('recent speed needs multiple samples and measures actual counter deltas, not request average', () => {
  const model = new SessionInsights();
  model.observe(reading(1000)); model.observe(reading(2000)); expect(model.speed).toBeNull();
  model.observe(reading(3000, { completionTokens: 80, liveDecodeTPS: 99 }));
  expect(model.speed).toEqual({ tokensPerSecond: 30, seconds: 2 });
  model.observe(reading(3000, { completionTokens: 9999 })); expect(model.speed?.tokensPerSecond).toBe(30);
  expect(model.recent).toHaveLength(0);
});

test('recent speed windows and history stay bounded and do not mix requests or models', () => {
  const model = new SessionInsights();
  for (let i = 1; i <= 100; i++) model.observe(reading(i * 1000));
  expect(model.speed?.seconds).toBeLessThanOrEqual(10);
  model.observe(reading(101000, { modelID: 'second', traceEpoch: 2 }));
  expect(model.speed).toBeNull(); expect(model.recent).toHaveLength(1); expect(model.recent[0]?.model).toBe('private-model');
  for (let i = 102; i < 130; i++) model.observe(reading(i * 1000, { traceEpoch: i }));
  expect(model.recent).toHaveLength(MAX_RECENT_GENERATIONS);
  model.clear(); expect(model.recent).toHaveLength(0); expect(model.speed).toBeNull();
});

test('counter resets, lost observations, pause and clock jumps do not produce giant or negative speed', () => {
  for (const patch of [{ completionTokens: 1 }, { elapsedSeconds: .1 }]) {
    const model = new SessionInsights(); model.observe(reading(1000)); model.observe(reading(2000));
    model.observe(reading(3000, patch)); expect(model.speed).toBeNull(); expect(model.recent[0]?.coverage).toBe('monitoring-gap');
  }
  const model = new SessionInsights(); model.observe(reading(1000)); model.observe(reading(2000)); model.observe(reading(3000));
  model.observe(reading(30000)); expect(model.speed).toBeNull(); expect(model.recent[0]?.coverage).toBe('monitoring-gap');
  model.break(); model.observe(reading(31000)); expect(model.speed).toBeNull();
  model.observe(frameReading('runtime_unreachable', null, 31_500)); expect(model.speed).toBeNull();
  model.observe(reading(32000)); model.observe(reading(30000)); expect(model.speed).toBeNull();
});

test('no recent speed while output is stale or identity is unknown', () => {
  const model = new SessionInsights();
  model.observe(reading(1000)); model.observe(reading(2000)); model.observe(reading(3000));
  model.observe(reading(4000, { phase: 'processing' })); expect(model.speed).toBeNull();
  model.observe(reading(5000, { traceEpoch: null })); expect(model.speed).toBeNull();
  const noID = new SessionInsights(); noID.observe(reading(1000, { traceEpoch: null })); noID.break(); expect(noID.recent).toEqual([]);
});

test('history records last seen output and footprint, without claiming request success or final totals', () => {
  const model = new SessionInsights();
  model.observe(reading(1000, { memory: { activeGB: 30 } }));
  model.observe(reading(2000, { memory: { activeGB: 34 } }));
  model.observe(reading(3000, { phase: 'idle', completionTokens: null }));
  expect(model.recent[0]).toMatchObject({ outputTokens: 40, averageTPS: 20, peakProcessBytes: 34e9, elapsedMs: 2000, coverage: 'no-longer-observed' });
  const report = recentGenerationsReport(model.recent, 'test');
  expect(report).not.toContain('private-model'); expect(report).toContain('not final'); expect(report).not.toContain('success');
  expect(report).toContain('reported elapsed 2s'); expect(report).toContain('peak observed process 31.66 GiB');
});

test('cache split never double-subtracts prefill or fabricates missing measurements', () => {
  expect(cacheSplit(100, 80)).toEqual({ total: 100, reused: 80, fresh: 20, percent: 80 });
  for (const [total, reused] of [[100, null], [100, 110], [0, 80], [100, -2], [100, .5]] as const) expect(cacheSplit(total, reused)).toBeNull();
  expect(reading(1000, { promptTokens: 100, cachedTokens: 80, prefillTotalTokens: 10 }).request).toMatchObject({ promptTokens: 100, cachedTokens: 80 });
});
