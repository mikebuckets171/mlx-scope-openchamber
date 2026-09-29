import type { HostClient, ToastRequest } from '@openchamber/sdk';
import type { AlertV2 } from '../../src/contract/alerts.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import type { RegressionFlag } from '../history/regress.ts';

// Owner: ui-core. Badge and toasts, from the leader only (P9, gated by toastSeq); a visible non-headless panel clears
// the badge itself. Toast text goes through panel/share/report.ts toastText (≤ 500 chars, no model names).

export type ToastPreference = 'critical' | 'all' | 'off';
/** Badge = the count of active badge-eligible alerts (plus regression flags in `all` mode). */
export const badgeCount = (alerts: readonly AlertV2[]): number => alerts.filter(alert => alert.badge).length;
export const toastFor = (alert: AlertV2, preference: ToastPreference): ToastRequest | null => { void alert; void preference; return null; };
export class Signals {
  constructor(host: Pick<HostClient, 'setBadge' | 'toast'>, preference: () => ToastPreference) { void host; void preference; }
  /** Applies one snapshot: toasts each new toastSeq and sets the badge only when `snapshot.lease.leader`. */
  apply(snapshot: SnapshotV2, flags: readonly RegressionFlag[]): void { void snapshot; void flags; }
  /** A visible panel mounted: setBadge(null). */
  panelMounted(): void {}
  dispose(): void {}
}
