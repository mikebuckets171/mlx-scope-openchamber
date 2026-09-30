// Test support only: every v2 route body filled to its caps, with every optional field present and strings at their
// longest, for the size limit and the honesty tables.
import { ALERT_IDS } from '../reasons.ts';
import { CAPABILITY_KEYS, capabilityScope } from '../capabilities.ts';
import { TREND_SERIES } from '../trend.ts';

const AT = 1_790_690_700_000;
const name = (index: number, length: number) => `${'m'.repeat(length - 4)}${String(index).padStart(4, '0')}`;
const model = (index: number) => name(index, 256);

export const fullSnapshot = () => ({
  contractVersion: 2, serverNow: AT, service: { version: '2.0.0-beta.10', instance: '5c1e0a7b' },
  connection: { id: 'c'.repeat(64), label: 'l'.repeat(120), runtime: 'lmstudio', version: 'v'.repeat(40), engine: 'splash', host: 'bionic',
    generation: 9_007_199_254_740_991, detection: { basis: 'probe', confidence: 'high', probe: '/lmstudio-greeting' },
    choices: Array.from({ length: 8 }, (_, index) => ({ id: `${'c'.repeat(63)}${index}`, label: name(index, 120), runtime: 'llama-server' })) },
  status: { state: 'failing', reason: 'runtime_unreachable', params: { port: 65_535, sinceAt: AT - 1 }, sinceAt: AT - 1 },
  capabilities: Object.fromEntries(CAPABILITY_KEYS.map(key => [key, { scope: capabilityScope(key), basis: 'last-observed' }])),
  runtime: {
    sampledAt: AT - 1, phase: 'prefill',
    request: { model: model(0), decodeTps: 123_456.789_012, prefillTps: 123_456.789_012, prefillProcessedTokens: 9_000_000, prefillTotalTokens: 9_999_999,
      prefillStale: false, prefillEtaMs: 123_456_789.012, promptTokens: 9_999_999, cachedTokens: 9_999_999, outputTokens: 9_999_999,
      elapsedMs: 123_456_789.012, ttftMs: 123_456.789, contextWindowTokens: 99_999_999, contextUsedTokens: 99_999_998 },
    server: { active: 999, queued: 999,
      averages: { decodeTps: 12_345.678_9, prefillTps: 12_345.678_9, cacheEfficiencyFraction: 0.123_456_789, requestsTotal: 9_999_999_999, failedTotal: 9_999_999, uptimeMs: 99_999_999_999 },
      histograms: { ttftMs: { p50: 1_234.567, p95: 12_345.678, n: 4096, window: 'native-last-4096' }, itlMs: { p50: 12.345, p95: 123.456, n: 4096, window: 'native-last-4096' } },
      cache: { ramBytes: 999_999_999_999, ssdBytes: 9_999_999_999_999, ramEntries: 999_999, ssdEntries: 999_999, lastLookup: 'miss' },
      speculative: { draftedTokens: 99_999_999, acceptedTokens: 88_888_888, acceptanceFraction: 0.888_888_88, windowMs: 600_000 },
      rates: { promptTps: 12_345.678_9, decodeTps: 12_345.678_9, windowMs: 60_000 } },
    memory: { processBytes: 999_999_999_999, modelBytes: 999_999_999_999, metalBytes: 999_999_999_998, metalPeakBytes: 999_999_999_999, ceilingBytes: 999_999_999_999, guard: 'hard' },
    residency: Array.from({ length: 12 }, (_, index) => ({ model: model(index), phase: 'prefill', source: 'ollama-ps', active: 1, queued: 999,
      bytes: 999_999_999_999, gpuResidentBytes: 999_999_999_999, unloadsAt: AT + 999_999, contextWindowTokens: 99_999_999,
      prefillFraction: 0.123_456_789, prefillTps: 12_345.678_9 })),
    residencyCount: 999,
    slots: Array.from({ length: 16 }, (_, index) => ({ id: index, busy: index === 0, contextWindowTokens: 99_999_999, decodedTokens: 9_999_999,
      remainingTokens: 9_999_999, promptTokens: 9_999_999, decodeTps: 12_345.678_9 })),
    catalog: Array.from({ length: 12 }, (_, index) => ({ name: name(index, 160), format: 'gguf', loaded: false, contextWindowTokens: 99_999_999,
      vision: true, inputModalities: ['text', 'image', 'audio'] })),
    engines: Array.from({ length: 8 }, (_, index) => ({ name: name(index, 40), version: 'v'.repeat(40), selected: index === 0 })),
  },
  host: { sampledAt: AT, platform: 'macOS', cpuModel: 'x'.repeat(80), logicalCores: 128, cpuFraction: 0.123_456_789,
    memTotalBytes: 999_999_999_999, memUsedBytes: 999_999_999_998,
    mac: { sampledAt: AT, pressureLevel: 4, wiredLimitBytes: 999_999_999_999, swapUsedBytes: 999_999_999_999, swapTotalBytes: 999_999_999_999,
      wiredBytes: 999_999_999_999, compressedBytes: 999_999_999_999 },
    gpu: { sampledAt: AT, busyFraction: 0.123_456_789, allocBytes: 999_999_999_999, inUseBytes: 999_999_999_999 },
    thermal: { sampledAt: AT, level: 4 }, runtimeProcess: { sampledAt: AT, runtime: 'omlx', port: 65_535, footprintBytes: 999_999_999_999 },
    power: { sampledAt: AT, field: 'all_power', chipW: 123.456_789, cpuW: 123.456_789, gpuW: 123.456_789, aneW: 123.456_789, sysW: 123.456_789, coverageFraction: 0.987_654_321 } },
  completions: { instance: '5c1e0a7b', cursor: 9_999_999_999, reset: true, items: Array.from({ length: 64 }, (_, index) => ({
    seq: 9_999_999_936 + index, finishedAt: AT - 64 + index, startedAt: AT - 999_999, model: model(index), basis: 'last-observed',
    promptTokens: 9_999_999, cachedTokens: 9_999_999, outputTokens: 9_999_999, ttftMs: 123_456.789, prefillMs: 123_456.789,
    decodeTps: 12_345.678_9, prefillTps: 12_345.678_9, overlapped: true, aggregateOf: 999,
    verdict: { attr: 'withheld', reason: 'too-many-projects', at: AT },
    host: { pressureMax: 4, swapDeltaBytes: -999_999_999_999, gpuAllocMaxBytes: 999_999_999_999, thermalMaxLevel: 4, energyJ: 123_456.789, powerCoverage: 0.987_654_321 },
  })) },
  marksHead: 9_999_999_999,
  alerts: ALERT_IDS.map(id => ({ id, severity: 'critical', since: AT - 1, params: id === 'model-unloaded' ? { model: model(99) } : id === 'swap-growth'
    ? { deltaBytes: 999_999_999_999, windowMs: 240_000 } : id === 'splash-recovering' ? { retryInMs: 30_000, crashTrace: true } : {}, badge: true, toastSeq: 9_999_999 })),
  alertLog: Array.from({ length: 20 }, (_, index) => ({ id: 'model-unloaded', severity: 'warning', since: AT - index * 1_000, until: AT, params: { model: model(index) } })),
  lease: { leader: false, epoch: 9_999_999, ttlMs: 12_000, leaderSurface: 'status' },
  nextPollMs: 10_000,
  compat: { message: 'x'.repeat(1_000), reason: 'host_unavailable', phase: 'reconnecting', runtime: 'omlx',
    connection: { selected: 's'.repeat(120), generation: '00000000-0000-4000-8000-000000000000', diagnostic: 'unsupported', coverage: 'inventory' },
    modelID: model(98), contextWindow: 99_999_999, statsState: 'stale', guardLevel: 3, lastMissReason: 'no_recent_store_probe', traceEpoch: 9_999_999 },
});

const bucket = (index: number) => [123_456.789_012 + index, 923_456.789_012 + index, 523_456.789_012 + index];
const integerBucket = (index: number) => [999_999_999_000 + index, 999_999_999_900 + index, 999_999_999_500 + index];
export const fullTrend = () => ({
  contractVersion: 2, serverNow: AT, windowMs: 3_600_000, bucketMs: 20_000, startAt: AT - 3_600_000,
  series: Object.fromEntries(TREND_SERIES.map(series => [series, { basis: 'last-observed', buckets: Array.from({ length: 180 }, (_, index) =>
    series === 'active' || series.endsWith('Bytes') ? integerBucket(index) : series === 'pressureLevel' ? [1, 4, 2]
      : series.endsWith('Fraction') ? [0.123_456_789, 0.987_654_321, 0.555_555_555] : bucket(index)) }])),
  gaps: Array.from({ length: 180 }, (_, index) => ({ fromAt: AT - 3_600_000 + index * 20_000, toAt: AT - 3_600_000 + index * 20_000 + 9_999 })),
  marks: Array.from({ length: 64 }, (_, index) => ({ seq: 9_999_999_936 + index, at: AT - index, phase: 'completed' })),
});

export const fullUsage = () => ({
  contractVersion: 2, serverNow: AT, available: true, range: '7d', cachedAt: AT, basis: 'reported', granularity: 'hour',
  buckets: Array.from({ length: 400 }, (_, index) => ({ at: AT - index * 3_600_000, requests: 999_999, promptTokens: 999_999_999_999,
    cachedTokens: 999_999_999_999, outputTokens: 999_999_999_999, totalTokens: 1_999_999_999_998 })),
  totals: { requests: 999_999_999, promptTokens: 999_999_999_999_999, cachedTokens: 999_999_999_999_999, outputTokens: 999_999_999_999_999 },
  models: Array.from({ length: 50 }, (_, index) => ({ model: model(index), requests: 999_999_999, promptTokens: 999_999_999_999_999, outputTokens: 999_999_999_999_999 })),
});
