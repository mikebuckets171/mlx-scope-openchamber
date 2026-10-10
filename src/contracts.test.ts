import { expect, test } from 'bun:test';
import { parse } from 'jsonc-parser/lib/esm/main.js';
import { normalizeOmlxTelemetry } from './telemetry.ts';
import { contextBudget } from '../panel/context.ts';
import { cacheSplit } from '../panel/insights.ts';
import { fromV1 } from '../panel/testing/readings.ts';
import { parseMediaJob, parseMediaSnapshot, withdrawMediaProgress, type MediaJobV1 } from './contract/media.ts';
import corpus from '../tests/fixtures/omlx-monitoring.json';
import configurations from '../tests/fixtures/jsonc.json';

for (const fixture of corpus.cases) test(`oMLX contract: ${fixture.name}`, () => {
  const input = fixture as {name: string; activity: unknown; stats?: unknown; contextWindows?: Record<string, number>; invalid?: boolean; expected?: Record<string, unknown>};
  const reading = normalizeOmlxTelemetry(input.stats ?? null, input.activity, new Map(Object.entries(input.contextWindows ?? {})));
  if (input.invalid) { expect(reading).toBeNull(); return; }
  expect(reading).not.toBeNull();
  const actual: Record<string, unknown> = {phase: reading!.phase, active: reading!.activeRequests, queued: reading!.queuedRequests,
    rate: reading!.liveDecodeTPS ?? reading!.livePrefillTPS, prompt: reading!.promptTokens, reused: reading!.cachedTokens,
    output: reading!.completionTokens, progress: reading!.prefillProgress, eta: reading!.prefillETASeconds,
    // The panel reads these through the v2 bridge, as it does in the host.
    contextRemaining: contextBudget(fromV1(reading!))?.remaining ?? null, inputReusedPercent: cacheSplit(reading!.promptTokens, reading!.cachedTokens)?.percent ?? null};
  for (const [key, value] of Object.entries(input.expected!)) expect(actual[key], `${fixture.name}: ${key}`).toEqual(value);
  expect(JSON.stringify(reading)).not.toContain('synthetic-a');
});
for (const fixture of configurations) test(`JSONC contract: ${fixture.name}`, () => {
  const errors: import('jsonc-parser/lib/esm/main.js').ParseError[] = [];
  const value = parse(fixture.text, errors, {allowTrailingComma: true});
  const valid = !errors.length && value !== null && typeof value === 'object' && !Array.isArray(value);
  expect(valid).toBe(fixture.valid);
});

// Media finish-time estimates (3.2): service-measured, phase-scoped, and strictly separated into live and held fields.
const MEDIA_LIVE: MediaJobV1 = { id: 'job1', sourceId: 'feed', kind: 'video', name: 'Video', state: 'running', phase: 'sampling', progress: { value: 8, total: 20, unit: 'steps', basis: 'phase' },
  sampledAtMs: 10_000, observedAtMs: 9_000, progressAtMs: 8_000, freshness: 'live', ownership: {}, cancel: { supported: false } };
const MEDIA_HELD = { ...MEDIA_LIVE, freshness: 'stale' as const, progress: null, lastProgress: MEDIA_LIVE.progress, lastProgressAtMs: 8_000, lastEtaAtMs: 70_000, etaBasis: 'measured-window' as const };
test('media contract: a live estimate needs live measured counters, its basis and a bounded time after its report', () => {
  const live = { ...MEDIA_LIVE, etaAtMs: 70_000, etaBasis: 'measured-window' as const };
  expect(parseMediaJob(live)).toEqual(live);
  expect(parseMediaJob({ ...live, etaAtMs: 8_000 })?.etaAtMs).toBe(8_000); // nothing left in the phase
  expect(parseMediaJob({ ...live, etaAtMs: 8_000 + 86_400_000 })?.etaAtMs).toBe(8_000 + 86_400_000);
  const { progressAtMs: _, ...unreported } = live; // without a progress time, the observation is the earliest possible report
  expect(parseMediaJob({ ...unreported, etaAtMs: 8_500 })).not.toHaveProperty('etaAtMs'); expect(parseMediaJob({ ...unreported, etaAtMs: 9_000 })?.etaAtMs).toBe(9_000);
  for (const invalid of [{ etaBasis: undefined }, { etaBasis: 'producer' }, { etaAtMs: 7_999 }, { etaAtMs: 8_000 + 86_400_001 }, { etaAtMs: -1 }, { etaAtMs: '70000' }, { etaAtMs: Number.NaN },
    { progress: null }, { freshness: 'stale' }, { freshness: 'unavailable' }, { state: 'waiting', phase: 'waiting' }, { state: 'queued', phase: 'queued' }, { state: 'cancelling' },
    { state: 'completed', phase: 'completed', freshness: 'last', finishedAtMs: 9_000 }]) {
    const parsed = parseMediaJob({ ...live, ...invalid });
    expect(parsed, JSON.stringify(invalid)).not.toBeNull();
    expect(parsed).not.toHaveProperty('etaAtMs'); expect(parsed).not.toHaveProperty('etaBasis'); expect(parsed).not.toHaveProperty('lastEtaAtMs');
  }
});
test('media contract: a held estimate is explicitly historical and belongs to a retained report', () => {
  expect(parseMediaJob(MEDIA_HELD)).toEqual(MEDIA_HELD);
  expect(parseMediaJob({ ...MEDIA_HELD, freshness: 'unavailable' })?.lastEtaAtMs).toBe(70_000);
  expect(parseMediaJob({ ...MEDIA_HELD, etaAtMs: 70_000 })).not.toHaveProperty('etaAtMs'); // never live while stale
  for (const invalid of [{ freshness: 'live' }, { lastProgress: undefined }, { lastProgressAtMs: undefined }, { lastEtaAtMs: 7_999 }, { lastEtaAtMs: 8_000 + 86_400_001 },
    { etaBasis: undefined }, { state: 'cancelling' }, { state: 'completed', phase: 'completed', freshness: 'last' }]) {
    const parsed = parseMediaJob({ ...MEDIA_HELD, ...invalid });
    expect(parsed, JSON.stringify(invalid)).not.toBeNull();
    expect(parsed).not.toHaveProperty('lastEtaAtMs'); expect(parsed).not.toHaveProperty('etaAtMs'); expect(parsed).not.toHaveProperty('etaBasis');
  }
});
test('media contract: snapshots from before estimates parse unchanged', () => {
  const source = { id: 'feed', kind: 'feed', label: 'Feed', state: 'ready', capabilities: { progress: true, cancel: false } };
  const { lastEtaAtMs: _a, etaBasis: _b, ...held } = MEDIA_HELD;
  const parsed = parseMediaSnapshot(JSON.parse(JSON.stringify({ schemaVersion: 1, sampledAtMs: 10_000, nextPollMs: 2_000, sources: [source], jobs: [MEDIA_LIVE, held] })));
  expect(parsed?.jobs).toEqual([MEDIA_LIVE, held]);
  for (const job of parsed!.jobs) for (const key of ['etaAtMs', 'lastEtaAtMs', 'etaBasis']) expect(job).not.toHaveProperty(key);
});
test('media contract: withdrawing progress moves a live estimate into the held field', () => {
  const live = { ...MEDIA_LIVE, etaAtMs: 70_000, etaBasis: 'measured-window' as const };
  const withdrawn = withdrawMediaProgress(live, 'stale');
  expect(withdrawn).toMatchObject({ freshness: 'stale', progress: null, lastProgress: live.progress, lastProgressAtMs: 8_000, lastEtaAtMs: 70_000, etaBasis: 'measured-window', cancel: { supported: false } });
  expect(withdrawn.etaAtMs).toBeUndefined();
  expect(parseMediaJob(withdrawn)?.lastEtaAtMs).toBe(70_000);
  expect(withdrawMediaProgress(withdrawn, 'unavailable')).toMatchObject({ lastEtaAtMs: 70_000, lastProgress: live.progress, freshness: 'unavailable' });
  for (const change of [{ progress: null }, { state: 'waiting' as const, phase: 'waiting' as const }, { etaAtMs: undefined, etaBasis: undefined }]) {
    const out = withdrawMediaProgress({ ...live, ...change }, 'stale');
    expect(out.lastEtaAtMs).toBeUndefined(); expect(out.etaAtMs).toBeUndefined(); expect(out.etaBasis).toBeUndefined();
  }
});
