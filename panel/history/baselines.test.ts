import { describe, expect, test } from 'bun:test';
import { BASELINE_EXCLUDE_RECENT_MS, BASELINE_WINDOW_MS, baselineFor, baselineKey, baselineOf, baselineStore, buildBaselines, parseBaselineStore,
  percentile, replyMetric, sameBaselines } from './baselines.ts';
import { reply } from '../testing/rows.ts';

const NOW = 1_790_690_700_000, H = 3_600_000;
const key = { rt: 'omlx', modelRef: 0, bucket: 2 } as const;
const series = (rates: number[], extra: Parameters<typeof reply>[0] extends infer F ? Partial<F> : never = {}) =>
  rates.map((decodeTps, index) => reply({ at: NOW - H - index * 60_000, decodeTps, ...extra }));

describe('baselines (plan §5.6)', () => {
  test('golden values: nearest-rank p50/p90 over the kept replies, always with n', () => {
    const rates = [25.7, 24.1, 26.3, 25.2, 27.9, 23.8, 25.9, 26.8, 24.6, 25.4, 26.1, 22.9];
    const baselines = buildBaselines(series(rates), NOW);
    // Sorted: 22.9 23.8 24.1 24.6 25.2 25.4 25.7 25.9 26.1 26.3 26.8 27.9 → p50 = 6th, p90 = 11th.
    expect(baselineFor(baselines, 'decodeTps', key)).toEqual({ p50: 25.4, p90: 26.8, n: 12 });
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([7], 0.9)).toBe(7);
  });
  test('p50 needs 5 replies and p90 needs 10; smaller keys stay with their n', () => {
    expect(baselineOf([1, 2, 3, 4])).toEqual({ p50: null, p90: null, n: 4 });
    expect(baselineOf([1, 2, 3, 4, 5])).toEqual({ p50: 3, p90: null, n: 5 });
    expect(baselineOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({ p50: 5, p90: 9, n: 10 });
  });
  test('the current 30 min and anything older than 14 days are left out', () => {
    const rows = [reply({ at: NOW - BASELINE_EXCLUDE_RECENT_MS + 1000, decodeTps: 99 }), reply({ at: NOW - BASELINE_WINDOW_MS - 1000, decodeTps: 99 }),
      ...series([20, 20, 20, 20, 20])];
    expect(baselineFor(buildBaselines(rows, NOW), 'decodeTps', key)).toEqual({ p50: 20, p90: null, n: 5 });
  });
  test('only the newest 50 values count', () => {
    const rows = [...series(Array(50).fill(30)), ...Array.from({ length: 20 }, (_, i) => reply({ at: NOW - 2 * 86_400_000 - i * 1000, decodeTps: 10 }))];
    expect(baselineFor(buildBaselines(rows, NOW), 'decodeTps', key)).toEqual({ p50: 30, p90: 30, n: 50 });
  });
  test('overlapped, aggregate and estimate rows count for nothing; last-observed rows count for rates but never TTFT', () => {
    const at = NOW - H;
    expect(replyMetric(reply({ at, decodeTps: 20, cofactors: 8 }), 'decodeTps')).toBeNull();
    expect(replyMetric(reply({ at, decodeTps: 20, cofactors: 16 }), 'decodeTps')).toBeNull();
    expect(replyMetric(reply({ at, decodeTps: 20, basis: 'estimate' }), 'decodeTps')).toBeNull();
    expect(replyMetric(reply({ at, decodeTps: 20, cofactors: 1 | 2 | 4 }), 'decodeTps')?.value).toBe(20);
    const observed = reply({ at, decodeTps: 24.9, prefillTps: 598, ttftMs: 480, basis: 'last-observed' });
    expect(replyMetric(observed, 'decodeTps')?.value).toBe(24.9);
    expect(replyMetric(observed, 'prefillTps')?.value).toBe(598);
    expect(replyMetric(observed, 'ttftMs')).toBeNull();
    expect(replyMetric(reply({ at, ttftMs: 480 }), 'ttftMs')?.value).toBe(480);
  });
  test('decode and tok/J key on the context bucket; prefill and TTFT on the uncached bucket', () => {
    const row = reply({ at: NOW - H, ctxB: 3, uncB: 1, decodeTps: 20, prefillTps: 500, ttftMs: 400, output: 1000, energyJ: 1250 });
    expect(replyMetric(row, 'decodeTps')?.key.bucket).toBe(3);
    expect(replyMetric(row, 'tokPerJ')).toEqual({ value: 0.8, key: { rt: 'omlx', modelRef: 0, bucket: 3 } });
    expect(replyMetric(row, 'prefillTps')?.key.bucket).toBe(1);
    expect(replyMetric(row, 'ttftMs')?.key.bucket).toBe(1);
  });
  test('a row without a model, a bucket or a value is not a reading, and zero is never one', () => {
    expect(replyMetric(reply({ at: NOW - H, decodeTps: 20, modelRef: null }), 'decodeTps')).toBeNull();
    expect(replyMetric(reply({ at: NOW - H, decodeTps: 20, ctxB: null }), 'decodeTps')).toBeNull();
    expect(replyMetric(reply({ at: NOW - H, decodeTps: 0 }), 'decodeTps')).toBeNull();
    expect(replyMetric(reply({ at: NOW - H, output: 1000, energyJ: 0 }), 'tokPerJ')).toBeNull();
  });
  test('models, runtimes and buckets never share a baseline', () => {
    const rows = [...series([20, 20, 20, 20, 20]), ...series([40, 40, 40, 40, 40], { modelRef: 1 }), ...series([60, 60, 60, 60, 60], { rt: 'splash' }),
      ...series([80, 80, 80, 80, 80], { ctxB: 4 })];
    const baselines = buildBaselines(rows, NOW);
    expect(baselines.get(baselineKey('decodeTps', key))?.p50).toBe(20);
    expect(baselines.get('decodeTps|omlx|1|2')?.p50).toBe(40);
    expect(baselines.get('decodeTps|splash|0|2')?.p50).toBe(60);
    expect(baselines.get('decodeTps|omlx|0|4')?.p50).toBe(80);
  });
  test('baseline.v2 round-trips, drops malformed entries and never throws', () => {
    const baselines = buildBaselines(series([20, 21, 22, 23, 24, 25]), NOW);
    const stored = JSON.parse(JSON.stringify(baselineStore(baselines, NOW)));
    const parsed = parseBaselineStore(stored)!;
    expect(parsed.computedAt).toBe(NOW);
    expect(sameBaselines(parsed.baselines, baselines)).toBe(true);
    expect(parseBaselineStore({ ...stored, entries: [...stored.entries, ['decodeTps|omlx|0|9', 1, 2, 3], ['<script>', 1, 2, 3], 'x', ['tokPerJ|omlx|0|1', 'a', null, -1]] })!.baselines.size)
      .toBe(baselines.size);
    for (const bad of [null, [], { v: 1 }, { v: 2, computedAt: 'x', entries: [] }, { v: 2, computedAt: 1 }]) expect(parseBaselineStore(bad)).toBeNull();
    expect(sameBaselines(baselines, buildBaselines(series([20, 21, 21.5, 23, 24, 25]), NOW))).toBe(false);
  });
  test('a 20,000-row ledger builds its baselines quickly', () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => reply({ at: NOW - H - i * 50_000, decodeTps: 20 + i % 7, prefillTps: 500 + i % 11, ttftMs: 300 + i % 13,
      modelRef: i % 4, ctxB: (i % 5) as 0, uncB: (i % 3) as 0, energyJ: 1000 + i % 17 }));
    const started = performance.now(), baselines = buildBaselines(rows, NOW);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect([...baselines.values()].every(base => base.n <= 50)).toBe(true);
  });
});
