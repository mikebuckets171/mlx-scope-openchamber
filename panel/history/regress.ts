import { HOST_COFACTORS, type ReplyRow } from '../history/ledger-schema.ts';
import { baselineKey, eligible, metricValue, rowKey, type BaselineMetric, type Baselines } from './baselines.ts';

// Owner: ui-history (logic built by the ledger track). "Slower than usual" (plan §5.6): the median of the last 3 replies
// within 30 min ≤ 0.85×p50 (rates) or ≥ 1.25×p50 (TTFT); clears within 10 %. One reply only gets a delta chip.
// Co-factors are "observed during", never causes. tok/J is an estimate: it gets a chip, never a flag.

export interface RegressionFlag { metric: BaselineMetric; key: string; recentMedian: number; p50: number; n: number; since: number; cofactors: number }
/** A reply's "vs usual" chip: ratio to p50 with n; null without a baseline. */
export interface VsUsual { metric: BaselineMetric; ratio: number; n: number; basis: 'reported' | 'estimate' }
export const REGRESSION = { replies: 3, windowMs: 1_800_000, rateFire: 0.85, rateClear: 0.9, ttftFire: 1.25, ttftClear: 1.1 } as const;
export const FLAG_METRICS: readonly BaselineMetric[] = ['decodeTps', 'prefillTps', 'ttftMs'];

const median3 = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[1]!;
export const evaluateRegression = (recent: readonly ReplyRow[], baselines: Baselines, now: number, previous: readonly RegressionFlag[]): RegressionFlag[] => {
  const fromS = (now - REGRESSION.windowMs) / 1000, flags: RegressionFlag[] = [];
  const rows = recent.filter(row => row[0] === 'r' && row[1] >= fromS && row[1] * 1000 <= now).sort((a, b) => a[1] - b[1]);
  for (const metric of FLAG_METRICS) {
    const groups = new Map<string, ReplyRow[]>();
    for (const row of rows) {
      const key = rowKey(metric, row);
      if (!key || metricValue(row, metric) === null || !eligible(row, metric)) continue;
      const name = baselineKey(metric, key);
      groups.set(name, [...groups.get(name) ?? [], row]);
    }
    for (const [key, group] of groups) {
      const base = baselines.get(key), last = group.slice(-REGRESSION.replies);
      if (!base || base.p50 === null || base.p50 <= 0 || last.length < REGRESSION.replies) continue;
      const recentMedian = median3(last.map(row => metricValue(row, metric)!)), ratio = recentMedian / base.p50;
      const was = previous.find(flag => flag.metric === metric && flag.key === key);
      const slower = metric === 'ttftMs'
        ? ratio >= REGRESSION.ttftFire || !!was && ratio > REGRESSION.ttftClear
        : ratio <= REGRESSION.rateFire || !!was && ratio < REGRESSION.rateClear;
      if (!slower) continue;
      flags.push({ metric, key, recentMedian, p50: base.p50, n: base.n, since: was?.since ?? last[0]![1] * 1000,
        cofactors: last.reduce((bits, row) => bits | row[15] & HOST_COFACTORS, 0) });
    }
  }
  return flags;
};
export const vsUsual = (row: ReplyRow, baselines: Baselines, metric: BaselineMetric): VsUsual | null => {
  const key = rowKey(metric, row), value = metricValue(row, metric);
  if (!key || value === null || !eligible(row, metric)) return null;
  const base = baselines.get(baselineKey(metric, key));
  return base && base.p50 !== null && base.p50 > 0
    ? { metric, ratio: value / base.p50, n: base.n, basis: metric === 'tokPerJ' ? 'estimate' : 'reported' } : null;
};
