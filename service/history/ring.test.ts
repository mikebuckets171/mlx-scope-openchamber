import { expect, test } from 'bun:test';
import { MAX_BODY_CHARS } from '../../src/contract/guards.ts';
import type { HostV2 } from '../../src/contract/host.ts';
import type { RuntimeV2 } from '../../src/contract/snapshot.ts';
import { parseTrendV2, TREND_BUCKETS, TREND_SERIES, type TrendSeries } from '../../src/contract/trend.ts';
import { HOST_FRESH_MS, TREND_BUCKET_MS, TREND_CAPACITY, TREND_SPAN_MS, TrendRing, trendBases, trendSample, type TrendSample } from './ring.ts';

const NOW = 1_790_690_700_000;
const WINDOW = { windowMs: 900_000 as const, series: ['decodeTps', 'active'] as TrendSeries[] };
const runtime = (patch: Partial<RuntimeV2> = {}): RuntimeV2 => ({
  phase: 'idle', request: null, server: { active: 0, queued: 0 }, memory: {}, residency: [], slots: [], catalog: [], engines: [], ...patch,
});
const host = (at: number, patch: Partial<HostV2> = {}): HostV2 => ({ sampledAt: at, cpuFraction: 0.25, memUsedBytes: 20 * 2 ** 30,
  mac: { sampledAt: at, pressureLevel: 1, swapUsedBytes: 2 ** 30 }, gpu: { sampledAt: at, busyFraction: 0.5 },
  power: { sampledAt: at, field: 'all_power', chipW: 31.5, coverageFraction: 1 }, ...patch });
/** Readings every `stepMs` over [from, to], each with the sample `at` returns. */
const fill = (ring: TrendRing, from: number, to: number, stepMs: number, sample: (at: number) => TrendSample): void => {
  for (let at = from; at <= to; at += stepMs) ring.append(at, sample(at));
};

test('a sample holds what the reading reports: rates only in their live phase, idle is absent, stale host parts are left out', () => {
  expect(trendSample(runtime(), null, NOW)).toEqual({ active: 0 });
  const decoding = runtime({ phase: 'decode', request: { model: 'm', decodeTps: 24.5, prefillTps: 600 }, server: { active: 1, queued: 0 } });
  expect(trendSample(decoding, host(NOW - 1_000), NOW)).toEqual({ decodeTps: 24.5, active: 1, cpuFraction: 0.25, memUsedBytes: 20 * 2 ** 30,
    swapUsedBytes: 2 ** 30, pressureLevel: 1, gpuBusyFraction: 0.5, chipW: 31.5 });
  expect(trendSample(runtime({ phase: 'prefill', request: { model: 'm', prefillTps: 600, prefillStale: true }, server: { active: 1, queued: 0 } }), null, NOW))
    .toEqual({ active: 1 });
  expect(trendSample(runtime({ phase: 'prefill', request: { model: 'm', prefillTps: 600, decodeTps: 9 }, server: { active: 1, queued: 0 } }), null, NOW))
    .toEqual({ prefillTps: 600, active: 1 });
  // A runtime that cannot count leaves `active` out rather than writing 0.
  expect(trendSample(runtime({ server: { active: null, queued: null } }), host(NOW - HOST_FRESH_MS - 1), NOW)).toEqual({});
  expect(trendSample(runtime(), host(NOW, { mac: { sampledAt: NOW - HOST_FRESH_MS - 1, pressureLevel: 4 } }), NOW)).not.toHaveProperty('pressureLevel');
  expect(trendBases({ 'request.decodeRate': { scope: 'request', basis: 'observed' }, 'host.power': { scope: 'host', basis: 'estimate' } }))
    .toEqual({ decodeTps: 'observed', chipW: 'estimate' });
});

test('buckets fold the 2 s readings into [min, max, last] and hold only readings: idle stays null, never 0', () => {
  const ring = new TrendRing(() => 500), start = NOW - 60_000;
  // 20 s decoding at a rising rate, then idle.
  fill(ring, start, NOW, 500, at => at < start + 20_000 ? { decodeTps: 20 + (at - start) / 1_000, active: 1 } : { active: 0 });
  const trend = ring.query(WINDOW, NOW, []);
  expect(parseTrendV2(structuredClone(trend))).toEqual(trend);
  expect(trend).toMatchObject({ contractVersion: 2, serverNow: NOW, windowMs: 900_000, bucketMs: 5_000, startAt: NOW - 900_000 });
  const decode = trend.series.decodeTps!, first = (start - trend.startAt) / 5_000;
  expect(decode.basis).toBe('reported');
  expect(decode.buckets.slice(0, first).every(bucket => bucket === null)).toBe(true);
  // Each 2 s ring bucket keeps its newest reading: the first 5 s bucket sees those at +1.5 s and +3.5 s.
  expect(decode.buckets[first]).toEqual([21.5, 23.5, 23.5]);
  expect(decode.buckets.slice(first, first + 4).every(Boolean)).toBe(true);
  expect(decode.buckets.slice(first + 4).every(bucket => bucket === null)).toBe(true);
  expect(trend.series.active!.buckets.slice(first).every(bucket => bucket !== null)).toBe(true);
  expect(trend.series.active!.buckets.slice(first + 5).every(bucket => bucket![1] === 0)).toBe(true);
  expect(trend.gaps).toEqual([{ fromAt: NOW - 900_000, toAt: start }]);
});

test('a pause longer than 2.5 cadences is a gap; readings inside the segment are never interpolated across it', () => {
  const ring = new TrendRing(() => 2_000);
  expect(ring.breakMs()).toBe(5_000);
  fill(ring, NOW - 600_000, NOW - 400_000, 2_000, () => ({ active: 1 }));
  expect(ring.append(NOW - 400_000 + 5_000, { active: 1 })).toBe(true);
  expect(ring.append(NOW - 400_000 + 10_001, { active: 1 })).toBe(false);
  fill(ring, NOW - 400_000 + 12_001, NOW - 100_000, 2_000, () => ({ active: 1 }));
  const trend = ring.query(WINDOW, NOW, []);
  expect(trend.gaps).toEqual([
    { fromAt: NOW - 900_000, toAt: NOW - 600_000 }, { fromAt: NOW - 395_000, toAt: NOW - 389_999 }, { fromAt: NOW - 101_999, toAt: NOW },
  ]);
  // No bucket inside a gap holds a reading (a gap starts right after its segment's last reading).
  const inside = (index: number) => { const from = trend.startAt + index * trend.bucketMs, to = from + trend.bucketMs;
    return trend.gaps.some(gap => from > gap.fromAt && to <= gap.toAt); };
  expect(trend.series.active!.buckets.every((bucket, index) => !inside(index) || bucket === null)).toBe(true);
  // The open segment runs to now while readings keep coming at the cadence.
  ring.append(NOW - 1_000, { active: 1 });
  expect(ring.query(WINDOW, NOW, []).gaps.at(-1)).toEqual({ fromAt: NOW - 101_999, toAt: NOW - 1_000 });
});

test('the break follows the slowest viewer: a status frame reading every 10 s keeps one segment', () => {
  let cadence = 10_000;
  const ring = new TrendRing(() => cadence);
  fill(ring, NOW - 300_000, NOW, 10_000, () => ({ cpuFraction: 0.1 }));
  expect(ring.query({ windowMs: 900_000, series: ['cpuFraction'] }, NOW, []).gaps).toEqual([{ fromAt: NOW - 900_000, toAt: NOW - 300_000 }]);
  cadence = 500;
  // Never under 2.5 buckets, so a slow read inside an active stretch does not split it.
  expect(ring.breakMs()).toBe(2.5 * TREND_BUCKET_MS);
});

test('an older or repeated reading adds nothing; readings older than 60 min fall out of a bounded ring', () => {
  const ring = new TrendRing(() => 2_000);
  expect(ring.append(NOW, { active: 2 })).toBe(false);
  expect(ring.append(NOW, { active: 9 })).toBe(true);
  expect(ring.append(NOW - 1_000, { active: 9 })).toBe(true);
  expect(ring.query({ windowMs: 900_000, series: ['active'] }, NOW, []).series.active!.buckets.at(-1)).toEqual([2, 2, 2]);
  const long = new TrendRing(() => 2_000), start = NOW - 2 * TREND_SPAN_MS;
  fill(long, start, NOW, 2_000, at => ({ active: at < NOW - TREND_SPAN_MS ? 7 : 1 }));
  const hour = long.query({ windowMs: 3_600_000, series: ['active'] }, NOW, []);
  expect(hour.series.active!.buckets.flatMap(bucket => bucket ?? [])).not.toContain(7);
  expect(hour.gaps).toEqual([]);
  expect((long as unknown as { times: Float64Array }).times).toHaveLength(TREND_CAPACITY);
});

test('a series whose basis changes starts over, so one window never mixes bases', () => {
  const ring = new TrendRing(() => 2_000);
  fill(ring, NOW - 60_000, NOW - 30_000, 2_000, () => ({ decodeTps: 20 }));
  fill(ring, NOW - 28_000, NOW, 2_000, () => ({ decodeTps: 30 }));
  const reported = ring.query({ windowMs: 900_000, series: ['decodeTps'] }, NOW, []);
  expect(reported.series.decodeTps!.basis).toBe('reported');
  const observed = new TrendRing(() => 2_000);
  fill(observed, NOW - 60_000, NOW - 30_000, 2_000, () => ({ decodeTps: 20 }));
  observed.append(NOW - 28_000, { decodeTps: 30 }, { decodeTps: 'observed' });
  const trend = observed.query({ windowMs: 900_000, series: ['decodeTps'] }, NOW, []);
  expect(trend.series.decodeTps!.basis).toBe('observed');
  expect(trend.series.decodeTps!.buckets.flatMap(bucket => bucket ?? [])).toEqual([30, 30, 30]);
});

test('marks inside the window go out without tags; unrequested or never-seen series are absent', () => {
  const ring = new TrendRing(() => 2_000);
  ring.append(NOW - 5_000, { active: 1 });
  const marks = [{ seq: 1, at: NOW - 1_000_000, phase: 'started' as const }, { seq: 2, at: NOW - 4_000, phase: 'completed' as const }];
  const trend = ring.query({ windowMs: 900_000, series: ['active', 'chipW'] }, NOW, marks);
  expect(trend.marks).toEqual([{ seq: 2, at: NOW - 4_000, phase: 'completed' }]);
  expect(Object.keys(trend.series)).toEqual(['active']);
  const empty = new TrendRing(() => 2_000).query({ windowMs: 1_800_000, series: ['decodeTps'] }, NOW, []);
  expect(empty).toEqual({ contractVersion: 2, serverNow: NOW, windowMs: 1_800_000, bucketMs: 10_000, startAt: NOW - 1_800_000, series: {},
    gaps: [{ fromAt: NOW - 1_800_000, toAt: NOW }], marks: [] });
  expect(parseTrendV2(empty)).toEqual(empty);
});

test('at maximum fill /v2/trend stays under the route limit and every gap survives the parser', () => {
  const ring = new TrendRing(() => 500), start = NOW - TREND_SPAN_MS;
  // Every series in every bucket, a break every 12 s (300 an hour, more than the ring keeps) and 80 marks.
  const every = (at: number): TrendSample => ({ decodeTps: 123.456789, prefillTps: 4_567.891, active: 3, cpuFraction: 0.123456, memUsedBytes: 51_539_607_552,
    swapUsedBytes: 12_884_901_888, pressureLevel: 4, gpuBusyFraction: 0.987654, chipW: 88.123456 + (at % 7) });
  for (let at = start; at <= NOW; at += 500) if ((at - start) % 12_000 < 6_000) ring.append(at, every(at));
  const marks = Array.from({ length: 80 }, (_, index) => ({ seq: index + 1, at: NOW - index * 1_000, phase: 'started' as const })).reverse();
  const trend = ring.query({ windowMs: 3_600_000, series: [...TREND_SERIES] }, NOW, marks);
  const body = JSON.stringify(trend);
  expect(body.length).toBeLessThan(MAX_BODY_CHARS);
  expect(Object.keys(trend.series)).toHaveLength(TREND_SERIES.length);
  expect(trend.gaps.length).toBe(TREND_BUCKETS - 2);
  expect(trend.marks).toHaveLength(64);
  expect(parseTrendV2(JSON.parse(body))).toEqual(trend);
});
