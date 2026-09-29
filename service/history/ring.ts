import type { HostV2 } from '../../src/contract/host.ts';
import type { RuntimeV2 } from '../../src/contract/snapshot.ts';
import type { TrendQuery } from '../../src/contract/query.ts';
import type { TrendSeries, TrendV2 } from '../../src/contract/trend.ts';
import type { TurnMark } from '../core/marks.ts';

// Owner: svc-history. 2 s × 1,800 buckets per slot (Float64Array time, Float32Array values), filled only by view-driven
// reads. A gap longer than 2.5× cadence is a segment break; buckets hold readings, never placeholders (contract §6.3).

export const TREND_BUCKET_MS = 2_000;
export const TREND_CAPACITY = 1_800;
export type TrendSample = Partial<Record<TrendSeries, number>>;
/** The series values one reading carries; a value the reading does not report is left out, never 0. */
export const trendSample = (runtime: RuntimeV2, host: HostV2 | null): TrendSample => { void runtime; void host; return {}; };

export class TrendRing {
  constructor(private readonly cadenceMs: () => number) {}
  append(at: number, sample: TrendSample): void { void this.cadenceMs; void at; void sample; }
  query(query: Pick<TrendQuery, 'windowMs' | 'series'>, now: number, marks: readonly TurnMark[]): TrendV2 {
    void query; void now; void marks;
    throw new Error('TrendRing.query: not implemented (svc-history)');
  }
}
