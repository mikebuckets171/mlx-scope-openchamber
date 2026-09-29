import { at, bool, count, defined, list, obj, oneOf, opt } from './guards.ts';
import { ALERT_IDS, ALERT_PARAMS, alertId, parseParams, type AlertId, type ReasonParams } from './reasons.ts';

export const SEVERITIES = ['info', 'warning', 'critical'] as const;
export type Severity = typeof SEVERITIES[number];
export const MAX_ALERT_LOG = 20;

export interface AlertV2 {
  id: AlertId; severity: Severity; since: number; params: ReasonParams;
  badge: boolean;
  toastSeq?: number;                         // present only for the leader; toast once per new value
}
export interface AlertLogEntryV2 { id: AlertId; severity: Severity; since: number; until: number | null; params: ReasonParams }

const severity = oneOf(SEVERITIES);
const head = (value: unknown) => {
  const item = obj(value), id = alertId(item?.id), level = severity(item?.severity), since = at(item?.since);
  return item && id && level && since !== null ? { item, id, severity: level, since, params: parseParams(item.params, ALERT_PARAMS[id]) } : null;
};
export const parseAlertV2 = (value: unknown): AlertV2 | null => {
  const parsed = head(value), badge = bool(parsed?.item.badge);
  if (!parsed || badge === null) return null;
  const { id, severity, since, params } = parsed;
  return defined({ id, severity, since, params, badge, toastSeq: opt(count(parsed.item.toastSeq)) });
};
export const parseAlertLogEntryV2 = (value: unknown): AlertLogEntryV2 | null => {
  const parsed = head(value);
  if (!parsed) return null;
  const until = at(parsed.item.until);
  const { id, severity, since, params } = parsed;
  return { id, severity, since, until: until !== null && until >= since ? until : null, params };
};
/** One live alert per id; the log is newest first and holds at most 20 entries. */
export const parseAlerts = (value: unknown): AlertV2[] => {
  const seen = new Set<AlertId>();
  return list(value, ALERT_IDS.length, raw => { const alert = parseAlertV2(raw); return alert && !seen.has(alert.id) ? (seen.add(alert.id), alert) : null; });
};
export const parseAlertLog = (value: unknown): AlertLogEntryV2[] =>
  list(value, Infinity, parseAlertLogEntryV2).sort((a, b) => b.since - a.since).slice(0, MAX_ALERT_LOG);
