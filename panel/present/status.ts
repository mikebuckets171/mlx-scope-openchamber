import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import type { TrendV2 } from '../../src/contract/trend.ts';
import type { AttributionLabel } from '../attribution/join.ts';
import type { TurnSummary } from '../attribution/turn.ts';
import type { VsUsual } from '../history/regress.ts';
import type { Reading } from './reading.ts';

// Owner: ui-core. The Work Status section and the rail's Compact mode (plan §5.8, G2): a glance line at 56 px (80 with
// an alert, 24 for a non-local chat) and the Turn stats replacement at ≤ 200 px. Rows a runtime cannot report are left out.

export type StatusMode = 'glance' | 'turn-stats' | 'non-local';
export interface StatusSectionInput {
  now: number;
  reading: Reading;                          // frame reasons (contract_mismatch, needs_approval…) arrive here
  snapshot: SnapshotV2 | null;
  attribution: AttributionLabel;
  turn: TurnSummary | null;                  // attribution; null when withheld or not observed
  vsUsual: VsUsual | null;                   // ui-history
  sparkline: TrendV2 | null;                 // 15 min decodeTps, ui-history's client
  chatIsLocal: boolean | null;               // the open chat's provider is the monitored connection; null = unknown
  expanded: boolean;
  tipDismissed: boolean;                     // pref.v2 "Replace Turn stats" tip
}
export interface StatusRow { label: string; value: string; basis: string | null }
export interface StatusSectionView {
  mode: StatusMode;
  height: number;                            // setHeight: 24 | 56 | 80 | ≤ 200
  line1: { phase: string; model: string | null; rate: string | null; attribution: string };
  line2: { chips: string[]; alert: string | null } | null;
  rows: StatusRow[];                         // turn-stats mode only
  tip: string | null;
}
export const presentStatusSection = (input: StatusSectionInput): StatusSectionView => {
  void input;
  throw new Error('presentStatusSection: not implemented (ui-core)');
};
