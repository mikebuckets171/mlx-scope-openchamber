import type { ReplyRow } from '../history/ledger-schema.ts';
import type { BaselineMetric, Baselines } from './baselines.ts';

// Owner: ui-history. "Slower than usual" (plan §5.6): the median of the last 3 replies within 30 min ≤ 0.85×p50 (rates)
// or ≥ 1.25×p50 (TTFT); clears within 10 %. One reply only gets a delta chip. Co-factors are "observed during", never causes.

export interface RegressionFlag { metric: BaselineMetric; key: string; recentMedian: number; p50: number; n: number; since: number; cofactors: number }
/** A reply's "vs usual" chip: ratio to p50 with n; null without a baseline. */
export interface VsUsual { metric: BaselineMetric; ratio: number; n: number; basis: 'reported' | 'estimate' }
export const evaluateRegression = (recent: readonly ReplyRow[], baselines: Baselines, now: number, previous: readonly RegressionFlag[]): RegressionFlag[] => {
  void recent; void baselines; void now; void previous;
  return [];
};
export const vsUsual = (row: ReplyRow, baselines: Baselines, metric: BaselineMetric): VsUsual | null => { void row; void baselines; void metric; return null; };
