import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseCompletionsV2 } from '../../src/contract/completion.ts';
import type { HostV2 } from '../../src/contract/host.ts';
import type { Phase, RequestV2, RuntimeV2 } from '../../src/contract/snapshot.ts';
import type { CompletionDraft } from '../core/adapter-v2.ts';
import {
  acceptDraft, COMPLETION_RING, CompletionRing, CompletionSequence, counterCompletion, HostCofactors, RequestWatch, WATCH_GAP_MS, type CounterRead,
} from './completions.ts';

const NOW = 1_790_690_700_000, INSTANCE = '5c1e0a7b';
const draft = (finishedAt: number, patch: Partial<CompletionDraft> = {}): CompletionDraft =>
  ({ finishedAt, startedAt: null, model: 'Example-27B-4bit', basis: 'last-observed', overlapped: false, ...patch });

test('seqs rise across every slot of one service; each ring keeps its newest 128', () => {
  const sequence = new CompletionSequence(), a = new CompletionRing(INSTANCE, sequence), b = new CompletionRing(INSTANCE, sequence);
  expect([a.append(draft(NOW), {}).seq, b.append(draft(NOW), {}).seq, a.append(draft(NOW + 1), { pressureMax: 2 }).seq]).toEqual([1, 2, 3]);
  expect([a.head, b.head, sequence.head]).toEqual([3, 2, 3]);
  const verdict = (seq: number) => seq === 3 ? { attr: 'inferred' as const, at: NOW + 2 } : undefined;
  const all = a.since(undefined, verdict);
  expect(all).toEqual({ instance: INSTANCE, cursor: 3, reset: false, items: [{ seq: 1, ...draft(NOW), host: {} },
    { seq: 3, ...draft(NOW + 1), verdict: { attr: 'inferred', at: NOW + 2 }, host: { pressureMax: 2 } }] });
  expect(parseCompletionsV2(structuredClone(all), INSTANCE)).toEqual(all);
  // Seq 2 is another slot's: not a gap for this one.
  expect(a.since(2, verdict)).toMatchObject({ reset: false, items: [{ seq: 3 }] });
  expect(a.since(3, verdict)).toMatchObject({ cursor: 3, reset: false, items: [] });
  // A cursor this ring never issued (a service restart, another connection) resyncs from the newest.
  expect(a.since(9, verdict)).toMatchObject({ cursor: 3, reset: true, items: [{ seq: 1 }, { seq: 3 }] });
  expect(new CompletionRing(INSTANCE).since(undefined, verdict)).toEqual({ instance: INSTANCE, cursor: 0, reset: false, items: [] });
});

test('a frame that fell behind pages forward 64 at a time; one whose next item fell off gets a reset', () => {
  const ring = new CompletionRing(INSTANCE);
  for (let index = 0; index < 200; index += 1) ring.append(draft(NOW + index), {});
  const seqs = (since: number | undefined) => { const page = ring.since(since, () => undefined); return [page.reset, page.items[0]?.seq, page.items.at(-1)?.seq, page.items.length]; };
  expect(seqs(200 - COMPLETION_RING)).toEqual([false, 73, 136, 64]);
  expect(seqs(136)).toEqual([false, 137, 200, 64]);
  expect(seqs(71)).toEqual([true, 137, 200, 64]);
  expect(seqs(undefined)).toEqual([false, 137, 200, 64]);
});

test('drafts reach the ring only with their runtime\'s basis and in wire shape', () => {
  expect(acceptDraft('omlx', draft(NOW))).toEqual(draft(NOW));
  expect(acceptDraft('omlx', draft(NOW, { basis: 'reported' }))).toBeNull();
  expect(acceptDraft('lmstudio', draft(NOW, { basis: 'reported', ttftMs: 520 }))).toMatchObject({ basis: 'reported', ttftMs: 520 });
  expect(acceptDraft('splash', draft(NOW, { basis: 'derived', aggregateOf: 2 }))).toMatchObject({ aggregateOf: 2 });
  expect(acceptDraft('llama-server', draft(NOW, { basis: 'observed' }))).toMatchObject({ basis: 'observed' });
  for (const kind of ['ollama', 'mlx-lm', null] as const) expect(acceptDraft(kind, draft(NOW))).toBeNull();
  expect(acceptDraft('omlx', draft(Number.NaN))).toBeNull();
  const cleaned = acceptDraft('omlx', draft(NOW, { model: '/Users/fixture/models/Example-27B-4bit', startedAt: NOW + 5, outputTokens: -1, aggregateOf: 1 }))!;
  expect(cleaned).toEqual({ ...draft(NOW), model: 'Example-27B-4bit' });
});

const runtime = (phase: Phase, request: Partial<RequestV2> | null, active: number | null = 1): RuntimeV2 => ({
  phase, request: request ? { model: 'private-model', ...request } : null, server: { active, queued: 0 }, memory: {}, residency: [], slots: [], catalog: [], engines: [],
});
const idle = () => runtime('idle', null, 0);

test('a request becomes one last-observed completion when it leaves the active list', () => {
  const watch = new RequestWatch();
  expect(watch.observe(runtime('prefill', { prefillFraction: 0.3, elapsedMs: 500, prefillTps: 600, promptTokens: 9_000, cachedTokens: 1_000 }), NOW)).toEqual([]);
  expect(watch.observe(runtime('prefill', { prefillFraction: 0.8, elapsedMs: 1_500, prefillTps: 610, promptTokens: 9_000, cachedTokens: 1_000 }), NOW + 1_000)).toEqual([]);
  expect(watch.observe(runtime('decode', { outputTokens: 5, decodeTps: 25, elapsedMs: 2_500, promptTokens: 9_000, cachedTokens: 1_000 }), NOW + 2_000)).toEqual([]);
  expect(watch.observe(runtime('decode', { outputTokens: 30, decodeTps: 26, elapsedMs: 3_500, promptTokens: 9_000, cachedTokens: 1_000 }), NOW + 3_000)).toEqual([]);
  // A cached reading (same time) and an older one change nothing.
  expect(watch.observe(idle(), NOW + 3_000)).toEqual([]);
  expect(watch.observe(idle(), NOW + 2_500)).toEqual([]);
  expect(watch.observe(idle(), NOW + 4_000)).toEqual([{ finishedAt: NOW + 3_000, startedAt: NOW - 500, model: 'private-model', basis: 'last-observed',
    promptTokens: 9_000, cachedTokens: 1_000, outputTokens: 30, prefillMs: 2_500, decodeTps: 26, prefillTps: 610, overlapped: false }]);
  expect(watch.observe(idle(), NOW + 5_000)).toEqual([]);
});

test('without a reported elapsed time, prefill time needs the request seen from its start', () => {
  const run = (fraction: number) => {
    const watch = new RequestWatch();
    watch.observe(runtime('prefill', { prefillFraction: fraction }), NOW);
    watch.observe(runtime('decode', { outputTokens: 4, decodeTps: 20 }), NOW + 1_000);
    return watch.observe(idle(), NOW + 2_000)[0]!;
  };
  expect(run(0.05)).toMatchObject({ startedAt: NOW, prefillMs: 1_000 });
  expect(run(0.5)).toMatchObject({ startedAt: NOW });
  expect(run(0.5)).not.toHaveProperty('prefillMs');
});

test('an end that was not watched is no completion: a gap, an unreadable runtime, or a request that never produced output', () => {
  const gap = new RequestWatch();
  gap.observe(runtime('decode', { outputTokens: 10 }), NOW);
  expect(gap.observe(idle(), NOW + WATCH_GAP_MS + 1)).toEqual([]);
  const lost = new RequestWatch();
  lost.observe(runtime('decode', { outputTokens: 10 }), NOW);
  expect(lost.observe(runtime('unknown', null, null), NOW + 1_000)).toEqual([]);
  expect(lost.observe(idle(), NOW + 2_000)).toEqual([]);
  const cancelled = new RequestWatch();
  cancelled.observe(runtime('prefill', { prefillFraction: 0.2 }), NOW);
  expect(cancelled.observe(idle(), NOW + 1_000)).toEqual([]);
});

test('a counter going back, another model, or prefill after decode is a new request; a reading without detail is not an end', () => {
  const watch = new RequestWatch();
  watch.observe(runtime('decode', { outputTokens: 50, elapsedMs: 4_000 }), NOW);
  expect(watch.observe(runtime('decode', { outputTokens: 3, elapsedMs: 500 }), NOW + 1_000)).toMatchObject([{ outputTokens: 50, finishedAt: NOW }]);
  expect(watch.observe(runtime('decode', { model: 'other-model', outputTokens: 9 }), NOW + 2_000)).toMatchObject([{ outputTokens: 3, model: 'private-model' }]);
  expect(watch.observe(runtime('prefill', { model: 'other-model', prefillFraction: 0.1 }), NOW + 3_000)).toMatchObject([{ outputTokens: 9, model: 'other-model' }]);
  const pause = new RequestWatch();
  pause.observe(runtime('decode', { outputTokens: 10 }), NOW);
  expect(pause.observe(runtime('processing', null, 1), NOW + 1_000)).toEqual([]);
  expect(pause.observe(runtime('decode', { outputTokens: 20 }), NOW + 2_000)).toEqual([]);
  expect(pause.observe(idle(), NOW + 3_000)).toMatchObject([{ outputTokens: 20, finishedAt: NOW + 2_000, overlapped: false }]);
});

test('a request that shared the server, or one on a runtime that cannot count, is overlapped', () => {
  const watch = new RequestWatch();
  watch.observe(runtime('decode', { outputTokens: 10 }), NOW);
  expect(watch.observe(runtime('processing', null, 2), NOW + 1_000)).toEqual([]);
  watch.observe(runtime('decode', { outputTokens: 30 }), NOW + 2_000);
  expect(watch.observe(idle(), NOW + 3_000)).toMatchObject([{ outputTokens: 30, overlapped: true }]);
  const uncounted = new RequestWatch();
  uncounted.observe(runtime('decode', { outputTokens: 10 }, null), NOW);
  expect(uncounted.observe(idle(), NOW + 1_000)).toMatchObject([{ overlapped: true }]);
  // Both requests ended while several ran: the watched one still finished, as last seen.
  const both = new RequestWatch();
  both.observe(runtime('decode', { outputTokens: 10 }), NOW);
  both.observe(runtime('processing', null, 2), NOW + 1_000);
  expect(both.observe(idle(), NOW + 2_000)).toMatchObject([{ outputTokens: 10, finishedAt: NOW, overlapped: true }]);
});

// Splash 1.1 /status fixtures, mapped the way the Splash adapter maps them (a test-side copy of that mapping).
type Body = Record<string, any>;
const status = (name: string): Body => JSON.parse(readFileSync(new URL(`../../tests/fixtures/splash/1.1.0/status.${name}.json`, import.meta.url), 'utf8'));
const counters = (body: Body, at: number, patch: Partial<CounterRead> = {}): CounterRead => ({
  at, completed: body.requests.completed, abandoned: body.requests.failed + body.requests.cancelled,
  active: body.requests.submitted - body.requests.completed - body.requests.failed - body.requests.cancelled,
  queued: body.scheduler.queued + body.admission.waiting, model: 'example-27b',
  ttftCount: body.latency.ttft.count, ttftSumMs: body.latency.ttft.sum * 1_000,
  promptTokens: body.metrics.prefill_input_tokens + body.cache.reused_tokens, cachedTokens: body.cache.reused_tokens,
  outputTokens: body.metrics.decode_output_tokens, prefillMs: body.metrics.prefill_wall_ms, decodeMs: body.metrics.decode_wall_ms, ...patch,
});

test('Splash Δ=1 with nothing else in flight is one derived completion with its own TTFT (412.5 ms)', () => {
  const before = counters(status('delta1-before'), NOW), after = counters(status('delta1-after'), NOW + 2_000);
  expect(counterCompletion(before, after)).toEqual({ finishedAt: NOW + 2_000, startedAt: null, model: 'example-27b', basis: 'derived',
    promptTokens: 5_312, cachedTokens: 4_864, outputTokens: 211, ttftMs: 412.5, prefillMs: 870.7, decodeTps: 54.05, prefillTps: 514.52, overlapped: false });
  expect(acceptDraft('splash', counterCompletion(before, after)!)).not.toBeNull();
});

test('Splash Δ=2 is one row with aggregateOf and a mean TTFT; the per-request rule withholds anything ambiguous', () => {
  const pair = counterCompletion(counters(status('delta2-before'), NOW), counters(status('delta2-after'), NOW + 2_000))!;
  expect(pair).toMatchObject({ aggregateOf: 2, overlapped: true, outputTokens: expect.any(Number) });
  expect(pair.ttftMs).toBeCloseTo(944.75, 0);
  const before = counters(status('delta1-before'), NOW), after = counters(status('delta1-after'), NOW + 2_000);
  // The request was already running at the first read: its TTFT is in the step, its tokens are not all.
  const running = counterCompletion({ ...before, active: 1 }, after)!;
  expect(running).toMatchObject({ ttftMs: 412.5, overlapped: false });
  for (const key of ['promptTokens', 'outputTokens', 'decodeTps', 'prefillMs']) expect(running).not.toHaveProperty(key);
  // Another request in flight or waiting after the step, a cancellation inside it, or no count: TTFT withheld, overlapped.
  for (const patch of [{ after: { active: 1 } }, { after: { queued: 1 } }, { after: { abandoned: 2 } }, { before: { active: null } }] as const) {
    const draft = counterCompletion({ ...before, ...'before' in patch ? patch.before : {} }, { ...after, ...'after' in patch ? patch.after : {} })!;
    expect(draft, JSON.stringify(patch)).toMatchObject({ overlapped: true });
    expect(draft).not.toHaveProperty('ttftMs');
  }
  // Two first tokens for one completion: no pairing.
  expect(counterCompletion(before, { ...after, ttftCount: after.ttftCount! + 1 })).not.toHaveProperty('ttftMs');
});

test('Splash counters that did not rise, or went back after a restart, are no completion', () => {
  expect(counterCompletion(counters(status('delta1-before'), NOW), counters(status('decoding'), NOW + 2_000))).toBeNull();
  expect(counterCompletion(counters(status('recovering'), NOW), counters(status('ready-after-crash'), NOW + 30_000))).toBeNull();
  const before = counters(status('delta1-before'), NOW);
  expect(counterCompletion(before, counters(status('delta1-after'), NOW))).toBeNull();
});

const hostAt = (at: number, patch: Partial<HostV2> = {}): HostV2 => ({ sampledAt: at, ...patch });
test('co-factors cover the completion\'s span: pressure, thermal and GPU maxima, the swap change and chip energy', () => {
  const cofactors = new HostCofactors();
  for (let second = 0; second <= 60; second += 1) {
    const at = NOW + second * 1_000, probe = NOW + Math.floor(second / 10) * 10_000;
    cofactors.observe(hostAt(at, {
      mac: { sampledAt: probe, pressureLevel: second >= 30 ? 2 : 1, swapUsedBytes: 2 ** 30 + Math.floor(second / 10) * 100 * 2 ** 20 },
      gpu: { sampledAt: probe, allocBytes: 20_000_000_000 + second }, thermal: { sampledAt: NOW + (second >= 40 ? 40_000 : 0), level: second >= 40 ? 2 : 0 },
      power: { sampledAt: at, field: 'all_power', chipW: 30, coverageFraction: 1 },
    }), at);
  }
  expect(cofactors.over(NOW + 5_000, NOW + 45_000)).toEqual({ pressureMax: 2, swapDeltaBytes: 400 * 2 ** 20, gpuAllocMaxBytes: 20_000_000_040,
    thermalMaxLevel: 2, energyJ: 1_200, powerCoverage: 1 });
  // No start: the readings in effect at the finish, and no change or energy over an unknown span.
  expect(cofactors.over(null, NOW + 25_000)).toEqual({ pressureMax: 1, gpuAllocMaxBytes: 20_000_000_020, thermalMaxLevel: 0 });
  expect(new HostCofactors(() => ({ energyJ: 99.94, coverage: 0.9 })).over(NOW, NOW + 10_000)).toEqual({ energyJ: 99.9, powerCoverage: 0.9 });
});

test('energy needs 80 % power coverage; sparser samples leave only the coverage', () => {
  const sparse = new HostCofactors();
  for (let second = 0; second <= 20; second += 1) {
    // A second apart to 10 s, then 12 s and every 3 s: 12 of the 20 s are covered.
    if (second <= 10 || second % 3 === 0) sparse.observe(hostAt(NOW + second * 1_000, { power: { sampledAt: NOW + second * 1_000, field: 'all_power', chipW: 20, coverageFraction: 1 } }), NOW + second * 1_000);
  }
  expect(sparse.over(NOW, NOW + 20_000)).toEqual({ powerCoverage: 0.6 });
  expect(new HostCofactors().over(NOW, NOW + 10_000)).toEqual({});
});
