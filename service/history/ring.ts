import type { Basis, Capabilities, CapabilityKey } from '../../src/contract/capabilities.ts';
import type { HostV2 } from '../../src/contract/host.ts';
import type { TrendQuery } from '../../src/contract/query.ts';
import type { RuntimeV2 } from '../../src/contract/snapshot.ts';
import { TREND_BUCKETS, TREND_MAX_MARKS, TREND_SERIES, type TrendBucket, type TrendSeries, type TrendV2 } from '../../src/contract/trend.ts';
import { CONTRACT_VERSION } from '../../src/contract/version.ts';
import type { TurnMark } from '../core/marks.ts';

// Owner: svc-history. 2 s × 1,800 buckets per slot (Float64Array time, Float32Array values), filled only by view-driven
// reads. A gap longer than 2.5× cadence is a segment break; buckets hold readings, never placeholders (contract §6.3).

export const TREND_BUCKET_MS = 2_000;
export const TREND_CAPACITY = 1_800;
export const TREND_SPAN_MS = TREND_BUCKET_MS * TREND_CAPACITY;
/** A pause between readings longer than this many cadences ends the segment (plan §4.3). */
export const SEGMENT_BREAK_CADENCES = 2.5;
/** A host part older than this at collection time is not a reading of that moment (probes run every 5–15 s). */
export const HOST_FRESH_MS = 30_000;
// Leading, between and trailing gaps must fit the parser's 180; segments beyond this drop their readings too.
const MAX_SEGMENTS = TREND_BUCKETS - 2;

export type TrendSample = Partial<Record<TrendSeries, number>>;
export type TrendBases = Partial<Record<TrendSeries, Basis>>;

/** The capability behind each series: a series is only sampled while its capability is present, and carries its basis. */
export const SERIES_CAPABILITY: Readonly<Record<TrendSeries, CapabilityKey>> = {
  decodeTps: 'request.decodeRate', prefillTps: 'request.prefillRate', active: 'server.requests', cpuFraction: 'host.cpu',
  memUsedBytes: 'host.memory', swapUsedBytes: 'host.swap', pressureLevel: 'host.pressure', gpuBusyFraction: 'host.gpuBusy', chipW: 'host.power',
};
/** The basis of each series whose capability is present. */
export const trendBases = (capabilities: Capabilities): TrendBases => {
  const bases: TrendBases = {};
  for (const series of TREND_SERIES) { const basis = capabilities[SERIES_CAPABILITY[series]]?.basis; if (basis) bases[series] = basis; }
  return bases;
};
/** Host parts are kernel and driver readings, chip power macmon's estimate; an adapter's capabilities carry no host keys. */
export const HOST_SERIES_BASIS: Readonly<TrendBases> = {
  cpuFraction: 'reported', memUsedBytes: 'reported', swapUsedBytes: 'reported', pressureLevel: 'reported', gpuBusyFraction: 'reported', chipW: 'estimate',
};

const fresh = <T extends { sampledAt: number }>(part: T | null | undefined, at: number | undefined): T | undefined =>
  part && (at === undefined || at - part.sampledAt <= HOST_FRESH_MS) ? part : undefined;
/**
 * The series values one reading carries; a value the reading does not report is left out, never 0. Rates exist only in
 * their own live phase, so an idle runtime is a line break, not a zero. Host parts count only while fresh at `at`.
 */
export const trendSample = (runtime: RuntimeV2, host: HostV2 | null, at: number | undefined = runtime.sampledAt): TrendSample => {
  const request = runtime.request, whole = fresh(host, at), mac = fresh(host?.mac, at), gpu = fresh(host?.gpu, at), power = fresh(host?.power, at);
  const sample: TrendSample = {
    decodeTps: runtime.phase === 'decode' ? request?.decodeTps : undefined,
    prefillTps: runtime.phase === 'prefill' && request?.prefillStale !== true ? request?.prefillTps : undefined,
    active: runtime.server.active ?? undefined, cpuFraction: whole?.cpuFraction, memUsedBytes: whole?.memUsedBytes,
    swapUsedBytes: mac?.swapUsedBytes, pressureLevel: mac?.pressureLevel, gpuBusyFraction: gpu?.busyFraction, chipW: power?.chipW,
  };
  for (const series of TREND_SERIES) if (sample[series] === undefined || !Number.isFinite(sample[series])) delete sample[series];
  return sample;
};

// Float32 keeps about 7 digits; the wire gets the precision each unit needs, and rounding keeps min ≤ last ≤ max.
const PRECISION: Readonly<Record<TrendSeries, number>> = {
  decodeTps: 100, prefillTps: 100, chipW: 100, cpuFraction: 10_000, gpuBusyFraction: 10_000,
  active: 1, memUsedBytes: 1, swapUsedBytes: 1, pressureLevel: 1,
};
const rounded = (series: TrendSeries, value: number): number => Math.round(value * PRECISION[series]) / PRECISION[series];
const bucketOf = (at: number): number => Math.floor(at / TREND_BUCKET_MS);

/**
 * One slot's last 60 min. Each 2 s bucket keeps the newest reading per series (a real sample, not an average) with its
 * own time inside the bucket; a query folds them into 180 [min, max, last] buckets. Segments record when Scope was
 * reading; outside them nothing is known.
 */
export class TrendRing {
  private readonly times = new Float64Array(TREND_CAPACITY).fill(Number.NaN);
  // Per series: the value, and its ms into the 2 s bucket, so a later reading without it never moves it (≈ 108 KiB a slot).
  private readonly values = new Map<TrendSeries, { value: Float32Array; offset: Uint16Array }>();
  private readonly bases = new Map<TrendSeries, Basis>();
  private readonly segments: Array<[fromAt: number, toAt: number]> = [];
  constructor(private readonly cadenceMs: () => number) {}

  /** The longest pause that still continues a segment: 2.5 cadences, and never under 2.5 buckets. */
  breakMs(): number { return SEGMENT_BREAK_CADENCES * Math.max(TREND_BUCKET_MS, this.cadenceMs()); }

  /** Adds one reading. Returns whether it continues the current segment; a reading no newer than the last adds nothing. */
  append(at: number, sample: TrendSample, bases: TrendBases = {}): boolean {
    if (!Number.isFinite(at)) return false;
    const last = this.segments.at(-1);
    if (last && at <= last[1]) return true;
    const covered = last !== undefined && at - last[1] <= this.breakMs();
    if (covered) last[1] = at; else this.segments.push([at, at]);
    while (this.segments.length > MAX_SEGMENTS || this.segments[0]![1] < at - TREND_SPAN_MS) this.segments.shift();
    const index = bucketOf(at) % TREND_CAPACITY;
    if (bucketOf(this.times[index]!) !== bucketOf(at)) for (const { value } of this.values.values()) value[index] = Number.NaN;
    this.times[index] = at;
    for (const series of TREND_SERIES) {
      const value = sample[series];
      if (value === undefined || !Number.isFinite(value)) continue;
      const basis = bases[series] ?? this.bases.get(series) ?? 'reported';
      let stored = this.values.get(series);
      // One window never mixes bases: a series whose basis changes (a re-detected runtime) starts over.
      if (!stored || this.bases.get(series) !== basis) {
        stored = { value: new Float32Array(TREND_CAPACITY).fill(Number.NaN), offset: new Uint16Array(TREND_CAPACITY) };
        this.values.set(series, stored);
        this.bases.set(series, basis);
      }
      stored.value[index] = value;
      stored.offset[index] = at - bucketOf(at) * TREND_BUCKET_MS;
    }
    return covered;
  }

  /** The readings between `now − window` and `now`, `null` where a bucket holds none, and every unread span as a gap. */
  query(query: Pick<TrendQuery, 'windowMs' | 'series'>, now: number, marks: readonly TurnMark[]): TrendV2 {
    const { windowMs } = query, bucketMs = windowMs / TREND_BUCKETS, startAt = now - windowMs;
    const segments = this.segments.filter(([fromAt, toAt]) => toAt >= startAt && fromAt <= now);
    // Segments are in time order: a binary search per reading.
    const read = (at: number): boolean => {
      if (!(at >= startAt && at <= now)) return false;
      for (let low = 0, high = segments.length - 1; low <= high;) {
        const middle = (low + high) >> 1, [fromAt, toAt] = segments[middle]!;
        if (at < fromAt) high = middle - 1; else if (at > toAt) low = middle + 1; else return true;
      }
      return false;
    };
    const series: TrendV2['series'] = {};
    for (const name of query.series) {
      const stored = this.values.get(name), basis = this.bases.get(name);
      if (!stored || !basis) continue;
      const buckets: TrendBucket[] = new Array(TREND_BUCKETS).fill(null), newest = new Float64Array(TREND_BUCKETS).fill(-Infinity);
      for (let index = 0; index < TREND_CAPACITY; index += 1) {
        const raw = stored.value[index]!;
        if (Number.isNaN(raw)) continue;
        const at = bucketOf(this.times[index]!) * TREND_BUCKET_MS + stored.offset[index]!;
        if (!read(at)) continue;
        const slot = Math.min(TREND_BUCKETS - 1, Math.floor((at - startAt) / bucketMs)), value = rounded(name, raw), bucket = buckets[slot];
        if (!bucket) buckets[slot] = [value, value, value];
        else { bucket[0] = Math.min(bucket[0], value); bucket[1] = Math.max(bucket[1], value); if (at > newest[slot]!) bucket[2] = value; }
        if (at > newest[slot]!) newest[slot] = at;
      }
      series[name] = { basis, buckets };
    }
    const gaps: TrendV2['gaps'] = [];
    let cursor = startAt;
    for (const [fromAt, toAt] of segments) {
      if (fromAt > cursor) gaps.push({ fromAt: cursor, toAt: fromAt });
      cursor = Math.max(cursor, toAt);
    }
    // The open segment runs to now while readings keep coming; after a break nothing was read.
    if (now - cursor > this.breakMs() || !segments.length) gaps.push({ fromAt: cursor, toAt: now });
    return {
      contractVersion: CONTRACT_VERSION, serverNow: now, windowMs, bucketMs, startAt, series, gaps,
      marks: marks.filter(mark => mark.at >= startAt && mark.at <= now).slice(-TREND_MAX_MARKS).map(({ seq, at, phase }) => ({ seq, at, phase })),
    };
  }
}
