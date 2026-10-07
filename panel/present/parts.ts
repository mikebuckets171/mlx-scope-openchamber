import type { AlertV2, Severity } from '../../src/contract/alerts.ts';
import type { Basis } from '../../src/contract/capabilities.ts';
import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import type { AttributionLabel } from '../attribution/join.ts';
import { alertCopy, rtName, sinceText, statusCopy, whyCopy, withheldWhy, type StatusCopy } from './copy.ts';
import { ENGINE_SPEED } from './scope.ts';
import { dur } from './format.ts';

// View-model pieces every 2.0 view shares: basis-labelled values, chips, ⓘ disclosures and callouts. Pure data; the
// markup lives in panel/render/views/parts.ts.

/** Anything but `reported` carries its basis in the UI (P3); `note` replaces the default word. */
export interface Val { text: string; strong?: string; unit?: string; basis: Basis; note?: string }
export const BASIS_WORD: Record<Basis, string> = { reported: '', derived: 'derived', observed: 'observed', 'last-observed': 'last observed', estimate: 'estimate' };
export const basisNote = (basis: Basis, note?: string): string | null => basis === 'reported' ? null : note ?? BASIS_WORD[basis];
/** Token-weighted speed across the steps that contain both token and speed readings. */
export const weightedTps = (steps: readonly CompletionV2[]): number | null => {
  const rated = steps.filter(step => step.outputTokens && step.decodeTps);
  const tokens = rated.reduce((sum, step) => sum + step.outputTokens!, 0), seconds = rated.reduce((sum, step) => sum + step.outputTokens! / step.decodeTps!, 0);
  return seconds > 0 ? tokens / seconds : null;
};

export type ChipTone = 'accent' | 'warn' | 'bad';
export interface Chip { text: string; tone?: ChipTone; outline?: boolean; attr?: 'inferred' | 'armed' | 'server'; reason?: string; basis?: Basis }
/** A server-wide chip always names its reason: inside the chip, or (glance) in a line the chip points to. */
export const attrChip = (label: AttributionLabel, short = false, chatRuntime: string | null = null): Chip => {
  if (label.kind === 'inferred') return { text: 'This chat · inferred', attr: 'inferred' };
  if (label.kind === 'armed') return { text: 'Next reply · armed', attr: 'armed', outline: true };
  const why = withheldWhy(label.reason, chatRuntime);
  return { text: short ? 'Server-wide' : `Server-wide · ${why}`, attr: 'server', outline: true, reason: why };
};

/** An ⓘ disclosure: a 24 px button whose explanation opens in flow under its row. `key` is stable across polls. */
export interface Tip { key: string; title: string; paras: string[] }
export const tip = (key: string, title: string, paras: ReadonlyArray<string | null | false | undefined>): Tip =>
  ({ key, title, paras: paras.filter((p): p is string => typeof p === 'string' && p.length > 0) });
/** The same measurement explanation follows Splash rates in Live and Server details. */
export const splashRateTip = (key: string, windowMs: number): Tip => tip(key, ENGINE_SPEED, [
  'Output tokens / native decode-command time, server-wide; excludes draft candidates.',
  `Last ${dur(windowMs)}; at least 3 samples across 2 s or more, rolling window up to 5 s.`,
  'Observation time is not the active decode time divisor.',
  'Lifetime average is separate. Client delivery speed is not measured here.',
]);
export const attrTip = (key: string, label: AttributionLabel, snapshot: SnapshotV2 | null, live: boolean, chatRuntime: string | null = null): Tip => {
  const [title, ...paras] = whyCopy(label.kind === 'server-wide' ? label.reason : label.kind, rtName(snapshot?.connection ?? null), live, chatRuntime);
  return tip(key, title, paras);
};

export interface Callout { key: string; severity: Severity; title: string; detail: string; since: string; action: { kind: 'connection' | 'switch'; label: string } | null }
const SEVERITY_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1 };
export const bySeverity = <T extends { severity: Severity }>(a: T, b: T): number => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
const statusCallout = (snapshot: SnapshotV2, copy: StatusCopy, now: number): Callout => ({
  key: `status-${snapshot.status.reason}`, severity: copy.severity, title: copy.title, detail: copy.detail, since: sinceText(copy.since, now),
  action: copy.action === 'connection' ? { kind: 'connection', label: 'Connection…' }
    : copy.action === 'switch' ? { kind: 'switch', label: `Switch to ${copy.title.replace(/^Looks like | now$/g, '')}` } : null,
});
/** Alerts the status message already says are left out, so each fact appears once per view. */
export const visibleAlerts = (snapshot: SnapshotV2): AlertV2[] => snapshot.alerts
  .filter(alert => !(alert.id === 'runtime-lost' && snapshot.status.state === 'failing') && !(alert.id === 'splash-recovering' && snapshot.status.state === 'recovering'))
  .sort((a, b) => bySeverity(a, b) || b.since - a.since);
export const alertCallout = (alert: AlertV2, now: number): Callout => {
  const [title, detail] = alertCopy(alert.id, alert.params);
  return { key: `alert-${alert.id}`, severity: alert.severity, title, detail, since: sinceText(alert.since, now), action: null };
};
/** The status message and every alert, most severe first; the view shows the first and puts the rest behind "N more". */
export const callouts = (snapshot: SnapshotV2 | null, now: number, extra: readonly Callout[] = []): Callout[] => {
  const status = snapshot ? statusCopy(snapshot) : null;
  return [...extra, ...status && snapshot ? [statusCallout(snapshot, status, now)] : [], ...snapshot ? visibleAlerts(snapshot).map(alert => alertCallout(alert, now)) : []]
    .sort(bySeverity);
};
