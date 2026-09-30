import type { AlertLogEntryV2, AlertV2 } from '../../src/contract/alerts.ts';
import { alertCopy, sinceText } from './copy.ts';
import { clock, dur } from './format.ts';
import { bySeverity } from './parts.ts';

// Owner: ui-core. Inline alert rows for every surface; English from panel/present/copy.ts (the mock copy table).

export interface AlertRow { id: string; severity: 'info' | 'warning' | 'critical'; text: string; since: string }
export interface AlertsView { top: AlertRow | null; rows: AlertRow[]; log: Array<{ at: string; text: string; severity?: AlertRow['severity']; duration?: string }> }
/** Most severe first, then newest; `top` is the one the callout and the glance's line 3 show. */
export const presentAlerts = (alerts: readonly AlertV2[], log: readonly AlertLogEntryV2[], now: number): AlertsView => {
  const rows = [...alerts].sort((a, b) => bySeverity(a, b) || b.since - a.since)
    .map(alert => ({ id: alert.id, severity: alert.severity, text: alertCopy(alert.id, alert.params)[0], since: sinceText(alert.since, now) }));
  return { top: rows[0] ?? null, rows,
    log: log.map(entry => ({ at: clock(entry.since, now), text: alertCopy(entry.id, entry.params)[0], severity: entry.severity,
      duration: entry.until === null ? 'active' : dur(entry.until - entry.since) })) };
};
