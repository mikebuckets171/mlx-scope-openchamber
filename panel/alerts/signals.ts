import type { HostClient, ToastRequest } from '@openchamber/sdk';
import type { AlertV2 } from '../../src/contract/alerts.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import type { RegressionFlag } from '../history/regress.ts';
import { alertToastCopy } from '../present/copy.ts';
import { toastText } from '../share/report.ts';

// Owner: ui-core. Badge and toasts, from the leader only (P9, gated by toastSeq); a visible non-headless panel clears
// the badge itself. Toast text goes through panel/share/report.ts toastText (≤ 500 chars, no model names).

export type ToastPreference = 'critical' | 'all' | 'off';
/** Badge = the count of active badge-eligible alerts (plus regression flags in `all` mode). */
export const badgeCount = (alerts: readonly AlertV2[]): number => alerts.filter(alert => alert.badge).length;
/** Critical alerts toast by default; `all` adds every alert the service offered a toast for; `off` never toasts. */
export const toastFor = (alert: AlertV2, preference: ToastPreference): ToastRequest | null => {
  if (alert.toastSeq === undefined || preference === 'off' || preference === 'critical' && alert.severity !== 'critical') return null;
  const model = typeof alert.params.model === 'string' ? [alert.params.model] : [];
  return { kind: alert.severity === 'critical' ? 'error' : 'info', message: toastText(alertToastCopy(alert.id, alert.params), model), dismiss: true };
};

export class Signals {
  private seen = new Map<string, number>();    // alert id → newest toastSeq this frame accounted for
  private badge: number | null | undefined;    // undefined: never set by this frame
  private primed = false;
  constructor(private readonly host: Pick<HostClient, 'setBadge' | 'toast'>, private readonly preference: () => ToastPreference,
    private readonly surface = 'panel') {}
  /** Applies one snapshot: toasts each new toastSeq and sets the badge only when `snapshot.lease.leader`. */
  apply(snapshot: SnapshotV2, flags: readonly RegressionFlag[]): void {
    const alive = new Set<string>(snapshot.alerts.map(alert => alert.id));
    for (const id of this.seen.keys()) if (!alive.has(id)) this.seen.delete(id);
    if (!snapshot.lease.leader) {
      // Not the leader: remember what is already up, so a handover never repeats the old leader's toasts.
      for (const alert of snapshot.alerts) if (!this.seen.has(alert.id)) this.seen.set(alert.id, alert.toastSeq ?? 0);
      this.primed = true;
      return;
    }
    for (const alert of snapshot.alerts) {
      const seq = alert.toastSeq, before = this.seen.get(alert.id);
      if (seq === undefined || before !== undefined && seq <= before) continue;
      this.seen.set(alert.id, seq);
      // The first leader snapshot of a frame that never saw these alerts toasts only ones that started just now.
      if (!this.primed && before === undefined && snapshot.serverNow - alert.since > 10_000) continue;
      const request = toastFor(alert, this.preference());
      if (request) void this.host.toast(request).catch(() => {});
    }
    this.primed = true;
    // A visible rail panel shows its alerts itself; the badge is for when it is closed (page or Work Status leads).
    if (this.surface === 'panel') return;
    const count = badgeCount(snapshot.alerts) + (this.preference() === 'all' ? flags.length : 0), next = count > 0 ? count : null;
    if (next !== this.badge) { this.badge = next; void this.host.setBadge(next).catch(() => {}); }
  }
  /** A visible panel mounted: setBadge(null). */
  panelMounted(): void { this.badge = null; void this.host.setBadge(null).catch(() => {}); }
  dispose(): void {}
}
