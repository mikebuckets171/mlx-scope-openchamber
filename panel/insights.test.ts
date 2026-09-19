import { expect, test } from 'bun:test';
import { normalizeOmlxTelemetry, parseTelemetrySnapshot, unavailableTelemetry, MAX_RESIDENT_MODELS } from '../src/telemetry.ts';
import { cacheSplit, prefillEstimate, SessionInsights, recentGenerationsReport, MAX_RECENT_GENERATIONS } from './insights.ts';
const reading = (at: number, overrides: object = {}) => {
  const snapshot = parseTelemetrySnapshot({ available: true, sampledAt: at, modelID: 'private-model', traceEpoch: 1, phase: 'decode',
    completionTokens: at / 1000 * 20, liveDecodeTPS: 20, activeRequests: 1, elapsedSeconds: at / 1000, ...overrides });
  if (!snapshot.available) throw Error('Invalid fixture');
  return snapshot;
};
const activity = (models: object[]) => normalizeOmlxTelemetry(null, { active_models: { models } })!;

test('prefill ETA is a reported estimate, never a synthetic countdown or completion prediction', () => {
  const raw = activity([{ id: 'm', active_requests: 1, prefilling: [{ processed: 64, total: 100, speed: 10, eta: 3.6 }] }]);
  expect(raw.prefillETASeconds).toBe(3.6);
  expect(prefillEstimate(raw)).toBe('~5s');
  expect(parseTelemetrySnapshot(raw)).toEqual(raw);
  expect(prefillEstimate({ ...raw, prefillETASeconds: 125 })).toBe('~3m');
  for (const value of [-1, Infinity, NaN, null]) expect(prefillEstimate({ ...raw, prefillETASeconds: value })).toBeNull();
  for (const patch of [{ prefillProgressStale: true }, { prefillProgress: 1 }, { prefillProgress: null }, { livePrefillTPS: 0 }]) {
    expect(prefillEstimate({ ...raw, ...patch })).toBeNull();
  }
  expect(prefillEstimate({ ...raw, prefillETASeconds: 0.1 })).toBe('<1s');
  expect(prefillEstimate(reading(1000))).toBeNull();
});

test('raw and wire contracts withhold stale, ambiguous and invalid ETA data', () => {
  const flight = { processed: 50, total: 100, speed: 10, eta: 5 };
  for (const patch of [{ progress_stale: true }, { total: 0 }, { processed: 101 }, { speed: 0 }, { eta: '5' }]) {
    expect(activity([{ id: 'm', prefilling: [{ ...flight, ...patch }] }]).prefillETASeconds).toBeNull();
  }
  expect(activity([{ id: 'm', active_requests: 2, prefilling: [flight] }]).prefillETASeconds).toBeNull();
  expect(reading(1000, { phase: 'prefill', prefillProgress: .5, prefillETASeconds: 2, livePrefillTPS: 1, prefillProgressStale: true }).prefillETASeconds).toBeNull();
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
});

test('model list is bounded and rejects raw request data, stale speeds and invalid measurements', () => {
  const result = activity(Array.from({ length: 100 }, (_, i) => ({ id: `model-${i}`, active_requests: 0 })));
  expect(result.residentModelCount).toBe(100); expect(result.residentModels).toHaveLength(MAX_RESIDENT_MODELS);
  const wire = reading(1000, { residentModels: [{ id: 'm'.repeat(1000), phase: 'prefill', tokensPerSecond: 100, prefillProgress: .5, progressStale: true, allocationGB: -1, prompt: 'PRIVATE' }] });
  expect(wire.residentModels[0]?.id).toHaveLength(256); expect(wire.residentModels[0]?.tokensPerSecond).toBeNull();
  expect(wire.residentModels[0]?.allocationGB).toBeNull(); expect(JSON.stringify(wire)).not.toContain('PRIVATE');
  expect(reading(1000).residentModels).toEqual([]);
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
  model.observe(unavailableTelemetry('runtime_unreachable')); expect(model.speed).toBeNull();
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
  expect(model.recent[0]).toMatchObject({ outputTokens: 40, averageTPS: 20, peakProcessGB: 34, coverage: 'no-longer-observed' });
  const report = recentGenerationsReport(model.recent, 'test');
  expect(report).not.toContain('private-model'); expect(report).toContain('not final'); expect(report).not.toContain('success');
});

test('cache split never double-subtracts prefill or fabricates missing measurements', () => {
  expect(cacheSplit(reading(1000, { promptTokens: 100, cachedTokens: 80, prefillTotalTokens: 10 }))).toEqual({ total: 100, reused: 80, fresh: 20, percent: 80 });
  for (const patch of [{ cachedTokens: null }, { cachedTokens: 110 }, { promptTokens: 0 }, { cachedTokens: -2 }, { cachedTokens: .5 }]) {
    expect(cacheSplit(reading(1000, { promptTokens: 100, cachedTokens: 80, ...patch }))).toBeNull();
  }
});
