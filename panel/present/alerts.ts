import type { AlertLogEntryV2, AlertV2 } from '../../src/contract/alerts.ts';

// Owner: ui-core. Inline alert rows for every surface; English from panel/present/reasons.ts alertMessage.

export interface AlertRow { id: string; severity: 'info' | 'warning' | 'critical'; text: string; since: string }
export interface AlertsView { top: AlertRow | null; rows: AlertRow[]; log: Array<{ at: string; text: string }> }
export const presentAlerts = (alerts: readonly AlertV2[], log: readonly AlertLogEntryV2[], now: number): AlertsView => {
  void alerts; void log; void now;
  return { top: null, rows: [], log: [] };
};
