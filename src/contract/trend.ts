import { basis, type Basis } from './capabilities.ts';
import { at, classAKeys, count, finite, list, obj, oneOf } from './guards.ts';
import { CONTRACT_VERSION } from './version.ts';

export const TREND_SERIES = ['decodeTps', 'prefillTps', 'active', 'cpuFraction', 'memUsedBytes', 'swapUsedBytes', 'pressureLevel',
  'gpuBusyFraction', 'chipW'] as const;
export type TrendSeries = typeof TREND_SERIES[number];
export const TREND_WINDOWS_MS = [900_000, 1_800_000, 3_600_000] as const;
export type TrendWindowMs = typeof TREND_WINDOWS_MS[number];
export const TREND_BUCKETS = 180;
export const TREND_MAX_MARKS = 64;
export const MARK_PHASES = ['started', 'completed', 'failure'] as const;
export type MarkPhase = typeof MARK_PHASES[number];
/** [min, max, last] over the samples that had a value; `null` when the bucket holds none (never a placeholder zero). */
export type TrendBucket = [min: number, max: number, last: number] | null;

export interface TrendV2 {
  contractVersion: 2;
  serverNow: number;
  windowMs: TrendWindowMs;
  bucketMs: number;                          // windowMs / 180
  startAt: number;
  series: Partial<Record<TrendSeries, { basis: Basis; buckets: TrendBucket[] }>>;
  gaps: Array<{ fromAt: number; toAt: number }>;   // "Not observed · Scope wasn't open"; never interpolated
  marks: Array<{ seq: number; at: number; phase: MarkPhase }>;   // no tags on the wire
}

const unit = (value: number) => value >= 0 && value <= 1;
const VALID: Record<TrendSeries, (value: number) => boolean> = {
  decodeTps: value => value >= 0, prefillTps: value => value >= 0, chipW: value => value >= 0,
  active: value => Number.isSafeInteger(value) && value >= 0,
  memUsedBytes: value => Number.isSafeInteger(value) && value >= 0, swapUsedBytes: value => Number.isSafeInteger(value) && value >= 0,
  cpuFraction: unit, gpuBusyFraction: unit, pressureLevel: value => value === 1 || value === 2 || value === 4,
};
/** A malformed bucket is not a reading: it becomes `null` rather than a guess. */
const bucket = (value: unknown, valid: (value: number) => boolean): TrendBucket => {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [min, max, last] = value.map(finite);
  return min !== null && max !== null && last !== null && min <= last && last <= max && [min, max, last].every(valid) ? [min, max, last] : null;
};

export const parseTrendV2 = (value: unknown): TrendV2 | null => {
  const item = obj(value), windowMs = oneOf(TREND_WINDOWS_MS)(item?.windowMs), serverNow = at(item?.serverNow), startAt = at(item?.startAt);
  if (!item || item.contractVersion !== CONTRACT_VERSION || classAKeys(item).length || !windowMs || serverNow === null || startAt === null
    || item.bucketMs !== windowMs / TREND_BUCKETS || !obj(item.series) || !Array.isArray(item.gaps) || !Array.isArray(item.marks)) return null;
  const series: TrendV2['series'] = {};
  for (const [raw, entry] of Object.entries(obj(item.series)!)) {
    const name = oneOf(TREND_SERIES)(raw), data = obj(entry), kind = basis(data?.basis);
    if (name && kind && Array.isArray(data?.buckets) && data.buckets.length <= TREND_BUCKETS) {
      series[name] = { basis: kind, buckets: data.buckets.map(entry => bucket(entry, VALID[name])) };
    }
  }
  return {
    contractVersion: CONTRACT_VERSION, serverNow, windowMs, bucketMs: windowMs / TREND_BUCKETS, startAt, series,
    gaps: list(item.gaps, TREND_BUCKETS, raw => {
      const gap = obj(raw), fromAt = at(gap?.fromAt), toAt = at(gap?.toAt);
      return fromAt !== null && toAt !== null && fromAt <= toAt ? { fromAt, toAt } : null;
    }),
    marks: list(item.marks, TREND_MAX_MARKS, raw => {
      const mark = obj(raw), seq = count(mark?.seq), when = at(mark?.at), phase = oneOf(MARK_PHASES)(mark?.phase);
      return seq !== null && when !== null && phase ? { seq, at: when, phase } : null;
    }),
  };
};
