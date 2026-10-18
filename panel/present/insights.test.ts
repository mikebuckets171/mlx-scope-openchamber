import { expect, test } from 'bun:test';
import type { RegressionFlag } from '../history/regress.ts';
import { CACHE_MISS_HOLD_MS, promptCacheMiss, slowdown } from './insights.ts';

const NOW = 1_790_690_700_000;
const turn = { startedAt: NOW - 20_000, endedAt: null };
const pair = (previous: { total: number; cache: number }, latest: { total: number; cache: number }, at = NOW - 5_000) =>
  ({ basis: 'reported' as const, previous: { ...previous, observedAt: at - 60_000 }, latest: { ...latest, observedAt: at } });

test('a prompt cache miss needs a mostly reused previous prompt and a mostly re-read newer one at least as long', () => {
  const miss = promptCacheMiss(pair({ total: 28_000, cache: 27_000 }, { total: 30_000, cache: 2_000 }), turn, NOW);
  expect(miss).toEqual({ key: 'cache-miss', text: 'Prompt cache miss · re-read 28.0K of 30.0K',
    detail: 'This prompt re-read 28.0K of 30.0K tokens; this chat’s previous prompt reused 27.0K. Both counts are reported by the engine. Scope does not know why the cache was not reused.' });
  // The previous prompt reused too little: under 4,096 tokens, or under half of itself.
  expect(promptCacheMiss(pair({ total: 6_000, cache: 4_000 }, { total: 7_000, cache: 0 }), turn, NOW)).toBeNull();
  expect(promptCacheMiss(pair({ total: 3_000, cache: 2_900 }, { total: 3_100, cache: 0 }), turn, NOW)).toBeNull();
  expect(promptCacheMiss(pair({ total: 20_000, cache: 9_000 }, { total: 21_000, cache: 0 }), turn, NOW)).toBeNull();
  // The newer prompt reused more than a quarter of itself, or is shorter than what was reused (a compacted chat).
  expect(promptCacheMiss(pair({ total: 28_000, cache: 27_000 }, { total: 30_000, cache: 8_000 }), turn, NOW)).toBeNull();
  expect(promptCacheMiss(pair({ total: 28_000, cache: 27_000 }, { total: 12_000, cache: 0 }), turn, NOW)).toBeNull();
  // A single prompt is never a miss.
  expect(promptCacheMiss({ basis: 'reported', latest: { total: 30_000, cache: 0, observedAt: NOW }, previous: null }, turn, NOW)).toBeNull();
});

test('a cache miss belongs to the chat’s newest turn and leaves five minutes after it ends', () => {
  const cache = pair({ total: 28_000, cache: 27_000 }, { total: 30_000, cache: 2_000 });
  expect(promptCacheMiss(cache, null, NOW)).toBeNull();
  expect(promptCacheMiss(cache, { startedAt: null, endedAt: null }, NOW)).toBeNull();
  // A prompt read before this turn began is the previous turn's.
  expect(promptCacheMiss(cache, { startedAt: NOW - 1_000, endedAt: null }, NOW)).toBeNull();
  const ended = { startedAt: NOW - 20_000, endedAt: NOW - 1_000 };
  expect(promptCacheMiss(cache, ended, NOW + CACHE_MISS_HOLD_MS - 1_000)).not.toBeNull();
  expect(promptCacheMiss(cache, ended, NOW + CACHE_MISS_HOLD_MS)).toBeNull();
});

const flag = (metric: RegressionFlag['metric'], cofactors = 0): RegressionFlag =>
  ({ metric, key: `${metric}|splash|0|2`, recentMedian: metric === 'ttftMs' ? 900 : 18.4, p50: metric === 'ttftMs' ? 500 : 25.2, n: 12, since: NOW, cofactors });

test('slower than usual names generation speed first and lists only what was observed, never as a cause', () => {
  expect(slowdown([])).toBeNull();
  const decode = slowdown([flag('ttftMs'), flag('decodeTps', 1 | 32 | 64)])!;
  expect(decode.text).toBe('Slower than usual · 18.4 tok/s vs 25.2 tok/s');
  expect(decode.detail).toBe('Middle of the last 3 replies against the usual for this model and size, from 12 replies. Observed during: memory pressure, requests queued, a media job running. These were present at the time; Scope does not know they caused it.');
  const ttft = slowdown([flag('ttftMs')])!;
  expect(ttft.text).toBe('First token slower than usual · 0.90 s vs 0.50 s');
  expect(ttft.detail).toContain('No measured condition on this Mac was present during those replies.');
  // Overlapped and aggregate bits are not conditions to list.
  expect(slowdown([flag('decodeTps', 8 | 16)])!.detail).toContain('No measured condition');
});
