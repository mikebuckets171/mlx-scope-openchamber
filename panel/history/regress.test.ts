import { describe, expect, test } from 'bun:test';
import { reply } from '../testing/rows.ts';
import { buildBaselines } from './baselines.ts';
import { evaluateRegression, RegressionTracker, vsUsual } from './regress.ts';

const NOW = 1_790_690_700_000, H = 3_600_000, MIN = 60_000;
// Usual decode 25 tok/s (n 20), prefill 600 tok/s, TTFT 500 ms.
const usual = buildBaselines(Array.from({ length: 20 }, (_, i) => reply({ at: NOW - 2 * H - i * MIN, decodeTps: 25, prefillTps: 600, ttftMs: 500 })), NOW);
const recent = (rates: number[], extra = {}) => rates.map((decodeTps, i) => reply({ at: NOW - (i + 1) * MIN, decodeTps, ...extra }));

describe('slower than usual (plan §5.6)', () => {
  test('fires when the median of the last 3 replies within 30 min is ≤ 0.85 × p50', () => {
    const [flag] = evaluateRegression(recent([20, 21, 19]), usual, NOW, []);
    expect(flag).toEqual({ metric: 'decodeTps', key: 'decodeTps|omlx|0|2', recentMedian: 20, p50: 25, n: 20, since: NOW, cofactors: 0 });
    expect(evaluateRegression(recent([22, 22, 22]), usual, NOW, [])).toEqual([]);
  });
  test('one or two slow replies are only a delta chip, never a flag', () => {
    expect(evaluateRegression(recent([10, 10]), usual, NOW, [])).toEqual([]);
    expect(vsUsual(reply({ at: NOW, decodeTps: 20 }), usual, 'decodeTps')).toEqual({ metric: 'decodeTps', ratio: 0.8, n: 20, basis: 'reported' });
  });
  test('replies older than 30 min do not count toward the last 3', () => {
    const rows = [...recent([20]), reply({ at: NOW - 31 * MIN, decodeTps: 20 }), reply({ at: NOW - 40 * MIN, decodeTps: 20 })];
    expect(evaluateRegression(rows, usual, NOW, [])).toEqual([]);
  });
  test('holds until the median is back within 10 % and keeps its since', () => {
    const tracker = new RegressionTracker();
    expect(tracker.update(recent([20, 20, 20]), usual, NOW)).toHaveLength(1);
    // 0.88 × p50: no longer past the 15 % line, but not yet within 10 %.
    expect(tracker.update(recent([22, 22, 22]), usual, NOW + 5 * MIN)).toEqual([expect.objectContaining({ since: NOW, recentMedian: 22 })]);
    expect(tracker.update(recent([23, 23, 23]), usual, NOW + 6 * MIN)).toEqual([]);
    expect(tracker.update(recent([22, 22, 22]), usual, NOW + 7 * MIN)).toEqual([]);
  });
  test('TTFT fires at ≥ 1.25 × p50 and last-observed replies never count for it', () => {
    expect(evaluateRegression(recent([25, 25, 25], { ttftMs: 700 }), usual, NOW, []).map(flag => flag.metric)).toEqual(['ttftMs']);
    expect(evaluateRegression(recent([25, 25, 25], { ttftMs: 700, basis: 'last-observed' }), usual, NOW, [])).toEqual([]);
  });
  test('co-factors are what the replies were observed with, never overlap or aggregate bits', () => {
    const rows = [reply({ at: NOW - MIN, decodeTps: 20, cofactors: 1 }), reply({ at: NOW - 2 * MIN, decodeTps: 20, cofactors: 4 }), reply({ at: NOW - 3 * MIN, decodeTps: 20 })];
    expect(evaluateRegression(rows, usual, NOW, [])[0]!.cofactors).toBe(5);
    expect(evaluateRegression(recent([20, 20, 20], { cofactors: 8 }), usual, NOW, [])).toEqual([]);
  });
  test('no baseline, no flag and no chip', () => {
    expect(evaluateRegression(recent([5, 5, 5], { modelRef: 7 }), usual, NOW, [])).toEqual([]);
    expect(vsUsual(reply({ at: NOW, decodeTps: 20, modelRef: 7 }), usual, 'decodeTps')).toBeNull();
    expect(vsUsual(reply({ at: NOW, output: 1000, energyJ: 1000 }), usual, 'tokPerJ')).toBeNull();
  });
});
