import { describe, expect, test } from 'bun:test';
import fixtures from '../../docs/design/2.0-mock-fixtures.json';
import { parseTrendV2, type TrendBucket, type TrendV2 } from '../../src/contract/trend.ts';
import { trendCeiling, trendGaps, trendGeometry } from './trend-chart.ts';

const T = parseTrendV2(fixtures.trend)!, FRESH = parseTrendV2(fixtures.trendFresh)!;
const START = 1_790_687_100_000;
const trend = (buckets: TrendBucket[], extra: Partial<TrendV2> = {}): TrendV2 => ({ contractVersion: 2, serverNow: START + 900_000, windowMs: 900_000, bucketMs: 5_000,
  startAt: START, series: { decodeTps: { basis: 'reported', buckets: [...buckets, ...Array(180 - buckets.length).fill(null)] } }, gaps: [], marks: [], ...extra });
const pathPoints = (path: string): number => (path.match(/[ML]/g) ?? []).length;

describe('trend geometry (plan §5.6)', () => {
  test('lines break at every null bucket; each run of readings is its own segment with its own band', () => {
    const g = trendGeometry(T, 'decodeTps')!;
    const runs = T.series.decodeTps!.buckets.reduce<number[]>((list, bucket, i, all) => bucket && !all[i - 1] ? [...list, 1] : bucket ? [...list.slice(0, -1), list.at(-1)! + 1] : list, []);
    expect(g.segments).toHaveLength(runs.length);
    expect(g.segments.map(pathPoints)).toEqual(runs.map(n => n === 1 ? 1 : n));
    expect(g.band).toHaveLength(runs.filter(n => n > 1).length);
    expect(g.readings).toBe(runs.reduce((a, b) => a + b, 0));
  });
  test('nothing is interpolated: the line is each bucket’s last reading, the band its min and max, never zero', () => {
    const g = trendGeometry(trend([[20, 30, 25], [22, 28, 24]]), 'decodeTps', 600, 120, 40)!;
    // y = 116 − v / 40 × 112; bucket centres at 2.5 s and 7.5 s of a 900 s window.
    expect(g.segments).toEqual(['M5.6 46.0 L8.9 48.8']);
    expect(g.band).toEqual(['M5.6 32.0 L8.9 37.6 L8.9 54.4 L5.6 60.0Z']);
    expect(g.low).toBe(20); expect(g.high).toBe(30); expect(g.max).toBe(40);
  });
  test('a chart needs 2 readings: fewer is no geometry, but not-observed spans are still drawn', () => {
    expect(trendGeometry(trend([[20, 30, 25]]), 'decodeTps')).toBeNull();
    expect(trendGeometry(FRESH, 'decodeTps')).toBeNull();
    expect(trendGaps(FRESH)).toEqual([{ x: 4, width: expect.closeTo(572.3, 1) }]);
    expect(trendGeometry(trend([[20, 30, 25]]), 'prefillTps')).toBeNull();
  });
  test('a lone reading between breaks stays visible as a short dash', () => {
    const g = trendGeometry(trend([[20, 20, 20], null, [21, 21, 21], [22, 22, 22]]), 'decodeTps')!;
    expect(g.segments[0]).toMatch(/^M4\.6 [\d.]+H6\.6$/);
  });
  test('only gaps[] are hatched, placed by time and clamped to the window', () => {
    const t = trend([[1, 2, 1], [1, 2, 1]], { gaps: [{ fromAt: START - 60_000, toAt: START + 90_000 }, { fromAt: START + 450_000, toAt: START + 450_000 }] });
    expect(trendGaps(t)).toEqual([{ x: 4, width: 59.2 }]);
    expect(trendGeometry(t, 'decodeTps')!.gaps).toEqual([{ x: 4, width: 59.2 }]);
  });
  test('turn marks become ticks and started → completed spans; an open turn runs to now', () => {
    const t = trend([[1, 2, 1], [1, 2, 1]], { marks: [{ seq: 1, at: START + 90_000, phase: 'started' }, { seq: 2, at: START + 180_000, phase: 'completed' },
      { seq: 3, at: START + 450_000, phase: 'started' }, { seq: 4, at: START + 500_000, phase: 'failure' }, { seq: 5, at: START + 810_000, phase: 'started' }] });
    const g = trendGeometry(t, 'decodeTps')!;
    expect(g.marks.map(mark => mark.phase)).toEqual(['started', 'completed', 'started', 'failure', 'started']);
    expect(g.spans.map(span => [span.x, span.width].map(n => Math.round(n * 10) / 10))).toEqual([[63.2, 59.2], [300, 32.9], [536.8, 59.2]]);
  });
  test('the ceiling is a round number above the highest reading', () => {
    expect([0, 3, 24.4, 26.4, 29, 95].map(trendCeiling)).toEqual([5, 5, 30, 30, 35, 100]);
    expect(trendGeometry(T, 'decodeTps')!.max).toBe(30);
  });
});
