import { expect, test } from 'bun:test';
import { parse } from 'jsonc-parser/lib/esm/main.js';
import { normalizeOmlxTelemetry } from '../tests/fixtures/legacy/telemetry.ts';
import { contextBudget } from '../panel/context.ts';
import { fromV1 } from '../panel/testing/readings.ts';
import { parseMediaJob, parseMediaSnapshot, withdrawMediaProgress, type MediaJobV1 } from './contract/media.ts';
import corpus from '../tests/fixtures/omlx-monitoring.json';
import configurations from '../tests/fixtures/jsonc.json';
/** Reused share of the prompt, as the 1.x insight computed it. */
const cacheSplit = (total: number | null | undefined, reused: number | null | undefined) =>
  total == null || reused == null || !Number.isSafeInteger(total) || !Number.isSafeInteger(reused) || total <= 0 || reused < 0 || reused > total
    ? null : { percent: reused / total * 100 };


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

// Media contract: measured lifecycle and freshness only; finish-time estimate fields never survive parsing.
const MEDIA_LIVE: MediaJobV1 = { id: 'job1', sourceId: 'comfy', kind: 'video', name: 'Video', state: 'running', phase: 'sampling', progress: { value: 8, total: 20, unit: 'steps', basis: 'phase' },
  sampledAtMs: 10_000, observedAtMs: 9_000, progressAtMs: 8_000, freshness: 'live', ownership: {}, cancel: { supported: true } };
const MEDIA_HELD = { ...MEDIA_LIVE, freshness: 'stale' as const, progress: null, lastProgress: MEDIA_LIVE.progress, lastProgressAtMs: 8_000, cancel: { supported: false } };
test('media contract: live counters parse exactly and retired estimate fields are dropped', () => {
  expect(parseMediaJob(MEDIA_LIVE)).toEqual(MEDIA_LIVE);
  for (const stale of [{ freshness: 'stale' as const }, { freshness: 'unavailable' as const }, { state: 'waiting' as const, phase: 'waiting' as const }, { progress: null }]) {
    const parsed = parseMediaJob({ ...MEDIA_LIVE, ...stale });
    expect(parsed, JSON.stringify(stale)).not.toBeNull();
    for (const key of ['etaAtMs', 'lastEtaAtMs', 'etaBasis', 'finalPhase']) expect(parsed).not.toHaveProperty(key);
  }
  expect(parseMediaJob({ ...MEDIA_LIVE, etaAtMs: 70_000, etaBasis: 'measured-window' })).toEqual(MEDIA_LIVE);
  expect(parseMediaJob(MEDIA_HELD)).toEqual(MEDIA_HELD);
  expect(parseMediaJob({ ...MEDIA_HELD, freshness: 'live' })?.progress).toBeNull(); // a held report cannot be live
});
test('media contract: snapshots parse unchanged and unknown producer fields never appear', () => {
  const source = { id: 'comfy', kind: 'comfyui', label: 'ComfyUI', state: 'ready', capabilities: { progress: true, cancel: true } };
  const parsed = parseMediaSnapshot(JSON.parse(JSON.stringify({ schemaVersion: 1, sampledAtMs: 10_000, nextPollMs: 2_000, sources: [source], jobs: [MEDIA_LIVE, MEDIA_HELD] })));
  expect(parsed?.jobs).toEqual([MEDIA_LIVE, MEDIA_HELD]);
  for (const job of parsed!.jobs) for (const key of ['etaAtMs', 'lastEtaAtMs', 'etaBasis']) expect(job).not.toHaveProperty(key);
});
test('media contract: withdrawing progress keeps only the last measured report', () => {
  const withdrawn = withdrawMediaProgress(MEDIA_LIVE, 'stale');
  expect(withdrawn).toMatchObject({ freshness: 'stale', progress: null, lastProgress: MEDIA_LIVE.progress, lastProgressAtMs: 8_000, cancel: { supported: false } });
  expect(parseMediaJob(withdrawn)?.lastProgressAtMs).toBe(8_000);
  const again = withdrawMediaProgress(withdrawn, 'unavailable');
  expect(again).toMatchObject({ freshness: 'unavailable', progress: null, lastProgress: MEDIA_LIVE.progress, lastProgressAtMs: 8_000 });
  for (const change of [{ progress: null }, { state: 'waiting' as const, phase: 'waiting' as const }]) {
    const out = withdrawMediaProgress({ ...MEDIA_LIVE, ...change }, 'stale');
    expect(out.lastProgress).toBeUndefined(); expect(out.lastProgressAtMs).toBeUndefined();
  }
});
