import type { AlertLogEntryV2 } from '../../src/contract/alerts.ts';
import type { TrendV2 } from '../../src/contract/trend.ts';
import type { UsageV2 } from '../../src/contract/usage.ts';
import type { LedgerAccounting } from '../history/accounting.ts';
import type { Baselines } from '../history/baselines.ts';
import type { LedgerRow } from '../history/ledger-schema.ts';
import type { RegressionFlag } from '../history/regress.ts';

// Owner: ui-history. Pure History tab presenter: trend, replies (each with its attr chip), turn summaries, baselines,
// oMLX usage ("Recorded by oMLX"), storage, alert log. Header "Observed while Scope was open" with counts per basis.

export interface HistoryInput {
  now: number;
  trend: TrendV2 | null;
  rows: readonly LedgerRow[];
  models: readonly string[];                 // in-view only
  baselines: Baselines;
  flags: readonly RegressionFlag[];
  usage: UsageV2 | null;
  storage: LedgerAccounting | null;
  paused: boolean;
  retentionDays: number;
  alertLog: readonly AlertLogEntryV2[];
}
export interface HistoryView {
  header: string;
  basisCounts: Array<{ basis: string; n: number }>;
  replies: Array<{ at: string; model: string; rate: string; ttft: string; tokens: string; attr: string; vsUsual: string | null }>;
  usage: { title: string; rows: Array<{ label: string; value: string }> } | null;
  storage: { used: string; fraction: number; retention: string; paused: boolean } | null;
  alertLog: Array<{ at: string; text: string }>;
}
export const presentHistory = (input: HistoryInput): HistoryView => {
  void input;
  throw new Error('presentHistory: not implemented (ui-history)');
};
