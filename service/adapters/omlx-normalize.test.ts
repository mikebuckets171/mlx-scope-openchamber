import { expect, test } from 'bun:test';
import corpus from '../../tests/fixtures/omlx-monitoring.json';
import { gbToBytes, percentToFraction, secondsToMs } from '../../src/contract/units.ts';
import { normalizeOmlxTelemetry } from '../../src/telemetry.ts';
import { cacheSplit } from '../../panel/insights.ts';
import { requestOf } from './omlx.ts';
import { normalizeOmlx, type OmlxNormalized } from './omlx-normalize.ts';
import { fixture, fixtureFiles, type Version } from './testing/omlx.ts';

type Case = { name: string; activity: unknown; stats?: unknown; contextWindows?: Record<string, number>; invalid?: boolean; expected?: Record<string, unknown> };
const cases = corpus.cases as Case[];
const windows = (item: Case) => new Map(Object.entries(item.contextWindows ?? {}));

// The 38-case corpus stays the normalizer oracle (plan §8.2): the moved copy answers every case as 1.6 did.
for (const item of cases) test(`oMLX oracle, moved normalizer: ${item.name}`, () => {
  const reading = normalizeOmlx(item.stats ?? null, item.activity, windows(item));
  if (item.invalid) { expect(reading).toBeNull(); return; }
  const request = requestOf(reading!), used = request?.contextUsedTokens, limit = request?.contextWindowTokens;
  const actual: Record<string, unknown> = { phase: reading!.phase, active: reading!.activeRequests, queued: reading!.queuedRequests,
    rate: reading!.liveDecodeTPS ?? reading!.livePrefillTPS, prompt: reading!.promptTokens, reused: reading!.cachedTokens,
    output: reading!.completionTokens, progress: reading!.prefillProgress, eta: reading!.prefillEtaMs === null ? null : reading!.prefillEtaMs / 1000,
    contextRemaining: used !== undefined && limit !== undefined ? limit - used : null,
    inputReusedPercent: cacheSplit(reading!.promptTokens, reading!.cachedTokens)?.percent ?? null };
  for (const [key, value] of Object.entries(item.expected!)) expect(actual[key], `${item.name}: ${key}`).toEqual(value);
  expect(JSON.stringify(reading)).not.toContain('synthetic-a');
});

/** 1.6's reading in v2 units: the only differences the move may make. */
const renamed = (v1: NonNullable<ReturnType<typeof normalizeOmlxTelemetry>>): Record<string, unknown> => ({
  message: v1.message, modelID: v1.modelID, phase: v1.phase, sessionStatsState: v1.sessionStatsState,
  sessionAveragePrefillTPS: v1.sessionAveragePrefillTPS, liveDecodeTPS: v1.liveDecodeTPS, livePrefillTPS: v1.livePrefillTPS,
  sessionAverageDecodeTPS: v1.sessionAverageDecodeTPS, sessionCacheEfficiencyFraction: percentToFraction(v1.sessionCacheEfficiencyPercent),
  promptTokens: v1.promptTokens, cachedTokens: v1.cachedTokens, completionTokens: v1.completionTokens, prefillProgress: v1.prefillProgress,
  prefillProcessedTokens: v1.prefillProcessedTokens, prefillTotalTokens: v1.prefillTotalTokens, prefillProgressStale: v1.prefillProgressStale,
  prefillEtaMs: secondsToMs(v1.prefillETASeconds), elapsedMs: secondsToMs(v1.elapsedSeconds), activeRequests: v1.activeRequests,
  queuedRequests: v1.queuedRequests, contextWindow: v1.contextWindow,
  memory: { activeBytes: gbToBytes(v1.memory?.activeGB), peakBytes: gbToBytes(v1.memory?.peakGB), modelBytes: gbToBytes(v1.memory?.modelGB), cacheBytes: gbToBytes(v1.memory?.cacheGB) },
  sessionBank: v1.sessionBank && { lastMissReason: v1.sessionBank.lastMissReason,
    hot: v1.sessionBank.hot && { totalBytes: gbToBytes(v1.sessionBank.hot.totalGB), entries: v1.sessionBank.hot.entries },
    cold: v1.sessionBank.cold && { totalBytes: gbToBytes(v1.sessionBank.cold.totalGB), entries: v1.sessionBank.cold.entries } },
  lifetime: v1.lifetime && { requestsTotal: v1.lifetime.requestsTotal, promptTokensTotal: v1.lifetime.promptTokensTotal,
    completionTokensTotal: v1.lifetime.completionTokensTotal, cachedTokensTotal: v1.lifetime.cachedTokensTotal, uptimeMs: secondsToMs(v1.lifetime.uptimeSeconds) },
  memoryPressureLevel: v1.memoryPressureLevel, sampledAt: v1.sampledAt, residentModelCount: v1.residentModelCount,
  residentModels: v1.residentModels.map(({ allocationGB, ...rest }) => ({ ...rest, allocationBytes: gbToBytes(allocationGB) })),
});
/** The additive fields the v2 mapping reads (the loading flag and each row's context window). */
const withoutAdditions = ({ loading: _, residentModels, ...rest }: OmlxNormalized): Record<string, unknown> =>
  ({ ...rest, residentModels: residentModels.map(({ loading: __, contextWindow: ___, ...row }) => row) });

// 1.6 only trusted a session body with the /admin/api/stats markers; the moved copy takes any object (G1).
const STATS = { engines: {}, active_models: { models: [] } };
const inputs: Array<[string, unknown, unknown, Map<string, number>]> = [
  ...cases.filter(item => !item.invalid).map(item => [item.name, item.stats && { ...STATS, ...item.stats as object }, item.activity, windows(item)] as [string, unknown, unknown, Map<string, number>]),
  ...(['0.7.0rc1', '0.6.4'] as Version[]).flatMap(version => fixtureFiles(version, 'admin-api-activity.').filter(file => !file.includes('unauthorized'))
    .flatMap(file => fixtureFiles(version, 'api-status.').filter(status => !/unauthorized|invalid/.test(status)).map(status =>
      [`${version} ${file} + ${status}`, { ...STATS, ...fixture(version, status) as object }, fixture(version, file),
        new Map([['Example-27B-4bit', 131_072]])] as [string, unknown, unknown, Map<string, number>]))),
];
test.each(inputs)('verbatim apart from unit renames: %s', (_, session, activity, contextWindows) => {
  const v1 = normalizeOmlxTelemetry(session ?? null, activity, contextWindows, null, 1_790_000_000_000, session ? 'fresh' : 'unavailable');
  const v2 = normalizeOmlx(session ?? null, activity, contextWindows, null, 1_790_000_000_000, session ? 'fresh' : 'unavailable');
  expect(v1).not.toBeNull();
  expect(withoutAdditions(v2!)).toEqual(renamed(v1!));
});

test('the session totals come from /api/status, whose cache efficiency is a percent', () => {
  const reading = normalizeOmlx(fixture('0.7.0rc1', 'api-status.idle.json'), fixture('0.7.0rc1', 'admin-api-activity.idle.json'))!;
  expect(reading.sessionCacheEfficiencyFraction).toBeCloseTo(0.803, 12);
  expect(reading).toMatchObject({ sessionAverageDecodeTPS: 27.3, sessionAveragePrefillTPS: 842.4,
    lifetime: { requestsTotal: 37, promptTokensTotal: 412_806, completionTokensTotal: 18_342, cachedTokensTotal: 331_590, uptimeMs: 5_421_300 },
    sessionBank: null, memory: { activeBytes: 17_448_304_640, modelBytes: 16_391_340_032, cacheBytes: null }, memoryPressureLevel: 1 });
  // No session body: nothing about the session is claimed.
  expect(normalizeOmlx(null, fixture('0.7.0rc1', 'admin-api-activity.idle.json'), new Map(), null, 0, 'unavailable'))
    .toMatchObject({ sessionAverageDecodeTPS: null, sessionCacheEfficiencyFraction: null, lifetime: null });
});

test('loading rows and 0.6.4 rows without `cluster` keep their per-model state', () => {
  const loading = normalizeOmlx(null, fixture('0.7.0rc1', 'admin-api-activity.loading.json'))!;
  expect(loading).toMatchObject({ phase: 'processing', loading: true, memory: { modelBytes: null }, residentModels: [{ loading: true, allocationBytes: null }] });
  const legacy = normalizeOmlx(null, fixture('0.6.4', 'admin-api-activity.generating.json'), new Map([['Example-27B-4bit', 131_072]]))!;
  expect(legacy).toMatchObject({ phase: 'decode', residentModels: [{ id: 'Example-27B-4bit', phase: 'decode', contextWindow: 131_072 }] });
});
