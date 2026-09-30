import type { ReplyRow } from '../history/ledger-schema.ts';
import { baselineKey, replyMetric, type BaselineMetric, type Baselines } from './baselines.ts';

// Owner: ui-history. "Slower than usual" (plan §5.6): the median of the last 3 replies within 30 min ≤ 0.85×p50 (rates)
// or ≥ 1.25×p50 (TTFT); clears within 10 %. One reply only gets a delta chip. Co-factors are "observed during", never causes.

export interface RegressionFlag { metric: BaselineMetric; key: string; recentMedian: number; p50: number; n: number; since: number; cofactors: number }
/** A reply's "vs usual" chip: ratio to p50 with n; null without a baseline. */
export interface VsUsual { metric: BaselineMetric; ratio: number; n: number; basis: 'reported' | 'estimate' }

export const REGRESSION = { replies: 3, withinMs: 1_800_000, rateFires: 0.85, ttftFires: 1.25, clearsWithin: 0.1 } as const;
/** tok/J is an estimate: it gets a "vs usual" chip but never a flag. */
const FLAGGED: readonly BaselineMetric[] = ['decodeTps', 'prefillTps', 'ttftMs'];
// Only what may have slowed the Mac is listed: 1 pressure ≥ warning, 2 swap grew, 4 thermal ≥ heavy.
const COFACTORS = 1 | 2 | 4;
const median3 = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[1]!;

export const evaluateRegression = (recent: readonly ReplyRow[], baselines: Baselines, now: number, previous: readonly RegressionFlag[]): RegressionFlag[] => {
  const groups = new Map<string, { metric: BaselineMetric; rows: Array<{ at: number; value: number; cofactors: number }> }>();
  for (const row of recent) {
    const at = row[1] * 1000;
    if (at > now || now - at > REGRESSION.withinMs) continue;
    for (const metric of FLAGGED) {
      const reading = replyMetric(row, metric);
      if (!reading) continue;
      const key = baselineKey(metric, reading.key), group = groups.get(key) ?? { metric, rows: [] };
      group.rows.push({ at, value: reading.value, cofactors: row[15] });
      groups.set(key, group);
    }
  }
  const flags: RegressionFlag[] = [];
  for (const [key, { metric, rows }] of groups) {
    const base = baselines.get(key), last = rows.sort((a, b) => b.at - a.at).slice(0, REGRESSION.replies);
    if (!base || base.p50 === null || last.length < REGRESSION.replies) continue;
    const recentMedian = median3(last.map(row => row.value)), ratio = recentMedian / base.p50, rate = metric !== 'ttftMs';
    const held = previous.find(flag => flag.key === key);
    // Hysteresis: a flag fires past 15 % (25 % for TTFT) and holds until the median is back within 10 %.
    const fires = rate ? ratio <= REGRESSION.rateFires : ratio >= REGRESSION.ttftFires;
    const holds = !!held && (rate ? ratio < 1 - REGRESSION.clearsWithin : ratio > 1 + REGRESSION.clearsWithin);
    if (fires || holds) flags.push({ metric, key, recentMedian, p50: base.p50, n: base.n, since: held?.since ?? now,
      cofactors: last.reduce((bits, row) => bits | row.cofactors & COFACTORS, 0) });
  }
  return flags.sort((a, b) => a.key < b.key ? -1 : 1);
};

export const vsUsual = (row: ReplyRow, baselines: Baselines, metric: BaselineMetric): VsUsual | null => {
  const reading = replyMetric(row, metric), base = reading ? baselines.get(baselineKey(metric, reading.key)) : undefined;
  return reading && base?.p50 ? { metric, ratio: reading.value / base.p50, n: base.n, basis: metric === 'tokPerJ' ? 'estimate' : 'reported' } : null;
};

/** Keeps each flag's `since` across evaluations; one per frame, fed the same rows the History view reads. */
export class RegressionTracker {
  private flags: RegressionFlag[] = [];
  get current(): readonly RegressionFlag[] { return this.flags; }
  update(recent: readonly ReplyRow[], baselines: Baselines, now: number): readonly RegressionFlag[] {
    return this.flags = evaluateRegression(recent, baselines, now, this.flags);
  }
  clear(): void { this.flags = []; }
}
