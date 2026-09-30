import { expect, test } from 'bun:test';
import type { Basis } from '../../src/contract/capabilities.ts';
import {
  BASELINE_EXCLUDE_RECENT_MS, BASELINE_WINDOW_MS, baselineFor, baselineKey, buildBaselines, parseBaselineStore, percentile, sameBaselines,
  toBaselineStore,
} from './baselines.ts';
import { COFACTOR, sizeBucket, type ReplyRow } from './ledger-schema.ts';
import { evaluateRegression, vsUsual, type RegressionFlag } from './regress.ts';

const NOW = 1_790_690_700_000, NOW_S = NOW / 1000;
let seq = 0;
/** A reply `ago` seconds before NOW: decode tok/s, TTFT ms, prefill tok/s; 12k prompt (8k cached → 4k uncached), 1k output. */
const reply = (ago: number, decode: number | null, ttft: number | null = 500, prefill: number | null = 600,
  extra: { basis?: Basis; bits?: number; energy?: number | null; prompt?: number; rt?: ReplyRow[2]; model?: number } = {}): ReplyRow =>
  ['r', NOW_S - ago, extra.rt ?? 'lmstudio', extra.model ?? 0, sizeBucket((extra.prompt ?? 12_000) + 1_000), sizeBucket((extra.prompt ?? 12_000) - 8_000),
    extra.prompt ?? 12_000, 8_000, 1_000, ttft,
    prefill === null ? null : Math.round(prefill * 10), decode === null ? null : Math.round(decode * 10), extra.basis ?? 'reported',
    'inferred', null, extra.bits ?? 0, extra.energy === undefined ? null : extra.energy === null ? null : Math.round(extra.energy * 10), `5c1e0a7b.${++seq}`];
const HOUR = 3_600;
const DECODE = 'decodeTps|lmstudio|0|1', TTFT = 'ttftMs|lmstudio|0|0', PREFILL = 'prefillTps|lmstudio|0|0', TOKJ = 'tokPerJ|lmstudio|0|1';

test('percentiles interpolate between closest ranks (R-7)', () => {
  expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
  expect(percentile([10], 0.9)).toBe(10);
  expect(percentile([30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41], 0.9)).toBeCloseTo(39.9, 10);
});

test('baseline golden values: window, the current 30 min, last 50, exclusions, n thresholds', () => {
  const rows: ReplyRow[] = [];
  for (let index = 0; index < 12; index++) rows.push(reply(2 * HOUR + index * 60, 30 + index, 400 + index * 10, 500 + index * 5, { energy: 100 + index * 10 }));
  rows.push(reply(10 * 60, 5, 5_000, 50));                              // inside the current 30 min: left out
  rows.push(reply(15 * 86_400, 5, 5_000, 50));                          // older than 14 days: left out
  rows.push(reply(3 * HOUR, 5, 5_000, 50, { bits: COFACTOR.overlapped }));
  rows.push(reply(3 * HOUR, 5, 5_000, 50, { bits: COFACTOR.aggregate }));
  rows.push(reply(3 * HOUR, 5, 5_000, 50, { basis: 'estimate' }));
  rows.push(reply(3 * HOUR, 36, 9_999, 700, { basis: 'last-observed', energy: 1 }));   // counts for rates, not TTFT or tok/J
  rows.push(reply(3 * HOUR, 40, 450, 520, { bits: COFACTOR.pressure | COFACTOR.thermal }));   // co-factors alone never exclude
  const baselines = buildBaselines(rows, NOW);
  // Decode: 30…41, 36 and 40 → 14 values.
  const decode = [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 36, 40].sort((a, b) => a - b);
  expect(baselines.get(DECODE)).toEqual({ p50: percentile(decode, 0.5), p90: percentile(decode, 0.9), n: 14 });
  expect(baselines.get(DECODE)!.p50).toBe(36);
  // TTFT: 400…510 and 450 → 13 values (the last-observed 9,999 is out).
  expect(baselines.get(TTFT)).toEqual({ p50: 450, p90: 498, n: 13 });
  expect(baselines.get(PREFILL)!.n).toBe(14);
  // tok/J: 1,000 output tokens / (100…210 J) → 12 values, an estimate baseline of its own.
  expect(baselines.get(TOKJ)!.n).toBe(12);
  expect(baselines.get(TOKJ)!.p50).toBeCloseTo((1_000 / 150 + 1_000 / 160) / 2, 10);
  expect(baselineFor(baselines, 'decodeTps', { rt: 'lmstudio', modelRef: 0, bucket: 1 })).toBe(baselines.get(DECODE)!);
  expect(baselineKey('ttftMs', { rt: 'omlx', modelRef: 3, bucket: 4 })).toBe('ttftMs|omlx|3|4');
});

test('p50 needs 5 values and p90 needs 10; n is always reported; only the newest 50 count', () => {
  const few = buildBaselines([1, 2, 3, 4].map(index => reply(HOUR + index, 30 + index)), NOW);
  expect(few.get(DECODE)).toEqual({ p50: null, p90: null, n: 4 });
  const some = buildBaselines([1, 2, 3, 4, 5, 6, 7, 8, 9].map(index => reply(HOUR + index, 30 + index)), NOW);
  expect(some.get(DECODE)).toEqual({ p50: 35, p90: null, n: 9 });
  const many = buildBaselines(Array.from({ length: 80 }, (_, index) => reply(HOUR + (80 - index) * 60, index < 30 ? 10 : 50)), NOW);
  expect(many.get(DECODE)).toEqual({ p50: 50, p90: 50, n: 50 });
});

test('keys: decode by context bucket, TTFT and prefill by uncached bucket, per runtime and model', () => {
  const rows = [reply(HOUR, 30, 500, 600, { prompt: 40_000 }), reply(HOUR, 30, 500, 600, { rt: 'omlx', model: 2 })];
  // 40k prompt + 1k output → context bucket 2 (32–64k); 32k uncached → bucket 1 (8–32k).
  expect([...buildBaselines(rows, NOW).keys()]).toEqual(['decodeTps|lmstudio|0|2', 'decodeTps|omlx|2|1', 'prefillTps|lmstudio|0|1',
    'prefillTps|omlx|2|0', 'ttftMs|lmstudio|0|1', 'ttftMs|omlx|2|0']);
  const unkeyed = reply(HOUR, 30);
  unkeyed[3] = null;
  expect(buildBaselines([unkeyed], NOW).size).toBe(0);
});

test('baseline.v2 round-trips, rejects junk and compares by value', () => {
  const baselines = buildBaselines(Array.from({ length: 12 }, (_, index) => reply(HOUR + index, 30 + index)), NOW);
  const stored = JSON.parse(JSON.stringify(toBaselineStore(baselines, NOW)));
  const parsed = parseBaselineStore(stored)!;
  expect(parsed.computedAt).toBe(NOW);
  expect(sameBaselines(parsed.baselines, baselines)).toBe(true);
  expect(parseBaselineStore({ ...stored, entries: [['decodeTps|lmstudio|0|1', 'x', null, 1], ['secret key', 1, 1, 1], ...stored.entries] })!.baselines.size)
    .toBe(baselines.size);
  expect(parseBaselineStore({ v: 1 })).toBeNull();
  expect(sameBaselines(baselines, buildBaselines([], NOW))).toBe(false);
  expect(BASELINE_WINDOW_MS).toBe(14 * 86_400_000);
  expect(BASELINE_EXCLUDE_RECENT_MS).toBe(1_800_000);
});

test('regression: median of the last 3 within 30 min ≤ 0.85×p50 fires, clears within 10 %; TTFT ≥ 1.25×p50', () => {
  const history = Array.from({ length: 20 }, (_, index) => reply(2 * HOUR + index * 60, 40, 500));
  const baselines = buildBaselines(history, NOW);
  expect(baselines.get(DECODE)!.p50).toBe(40);
  const slow = [reply(20 * 60, 33, 650, 600, { bits: COFACTOR.pressure }), reply(10 * 60, 34, 640, 600, { bits: COFACTOR.overlapped }), reply(60, 35, 700, 600, { bits: COFACTOR.thermal })];
  // The overlapped reply is not a per-request figure: only two eligible remain, so nothing fires.
  expect(evaluateRegression(slow, baselines, NOW, [])).toEqual([]);
  slow[1] = reply(10 * 60, 34, 640, 600, { bits: COFACTOR.swap });
  const flags = evaluateRegression(slow, baselines, NOW, []);
  expect(flags).toEqual([
    { metric: 'decodeTps', key: DECODE, recentMedian: 34, p50: 40, n: 20, since: (NOW_S - 20 * 60) * 1000, cofactors: COFACTOR.pressure | COFACTOR.swap | COFACTOR.thermal },
    { metric: 'ttftMs', key: TTFT, recentMedian: 650, p50: 500, n: 20, since: (NOW_S - 20 * 60) * 1000, cofactors: COFACTOR.pressure | COFACTOR.swap | COFACTOR.thermal },
  ]);
  // Hysteresis: 0.875 and 1.12 hold an active flag; 0.9 and 1.1 clear it; neither fires from scratch.
  const middling = [reply(300, 35, 560), reply(200, 35, 560), reply(100, 35, 560)];
  expect(evaluateRegression(middling, baselines, NOW, []).map(flag => flag.metric)).toEqual([]);
  const held = evaluateRegression(middling, baselines, NOW, flags);
  expect(held.map(flag => [flag.metric, flag.since])).toEqual([['decodeTps', flags[0]!.since], ['ttftMs', flags[1]!.since]]);
  expect(evaluateRegression([reply(300, 36, 550), reply(200, 36, 550), reply(100, 36, 550)], baselines, NOW, flags)).toEqual([]);
  // Older than 30 min, or only one reply: a chip at most, never a flag.
  expect(evaluateRegression([reply(40 * 60, 20), reply(35 * 60, 20), reply(31 * 60, 20)], baselines, NOW, [])).toEqual([]);
  expect(evaluateRegression([reply(60, 20)], baselines, NOW, [])).toEqual([]);
});

test('tok/J never flags; vs usual gives a ratio with n and the baseline\'s basis, and nothing for ineligible rows', () => {
  const history = Array.from({ length: 12 }, (_, index) => reply(2 * HOUR + index * 60, 40, 500, 600, { energy: 100 }));
  const baselines = buildBaselines(history, NOW);
  const recent = [reply(300, 40, 500, 600, { energy: 400 }), reply(200, 40, 500, 600, { energy: 400 }), reply(100, 40, 500, 600, { energy: 400 })];
  expect(evaluateRegression(recent, baselines, NOW, [] as RegressionFlag[])).toEqual([]);
  expect(vsUsual(recent[0]!, baselines, 'tokPerJ')).toEqual({ metric: 'tokPerJ', ratio: 0.25, n: 12, basis: 'estimate' });
  expect(vsUsual(reply(60, 44), baselines, 'decodeTps')).toEqual({ metric: 'decodeTps', ratio: 1.1, n: 12, basis: 'reported' });
  expect(vsUsual(reply(60, 44, 500, 600, { bits: COFACTOR.aggregate }), baselines, 'decodeTps')).toBeNull();
  expect(vsUsual(reply(60, 44, 500, 600, { basis: 'last-observed' }), baselines, 'ttftMs')).toBeNull();
  expect(vsUsual(reply(60, 44, 500, 600, { rt: 'omlx' }), baselines, 'decodeTps')).toBeNull();
  expect(vsUsual(reply(60, null), baselines, 'decodeTps')).toBeNull();
});
