import { expect, test } from 'bun:test';
import type { ToastRequest } from '@openchamber/sdk';
import type { AlertV2 } from '../../src/contract/alerts.ts';
import { parseSnapshotV2, type SnapshotV2 } from '../../src/contract/snapshot.ts';
import { MOCK_NOW, mockBody } from '../testing/mock-states.ts';
import { badgeCount, Signals, toastFor, type ToastPreference } from './signals.ts';

const snapshot = (alerts: AlertV2[], leader = true, now = MOCK_NOW): SnapshotV2 => ({ ...parseSnapshotV2(JSON.parse(JSON.stringify(mockBody('decode', { now }))))!,
  serverNow: now, alerts, lease: { leader, epoch: 1, ttlMs: 12_000, leaderSurface: leader ? 'status' : 'page' } });
const alert = (id: AlertV2['id'], severity: AlertV2['severity'], toastSeq?: number, params: AlertV2['params'] = {}, since = MOCK_NOW - 1_000): AlertV2 =>
  ({ id, severity, since, params, badge: true, ...toastSeq === undefined ? {} : { toastSeq } });
const recorder = (surface = 'status', preference: ToastPreference = 'critical') => {
  const toasts: ToastRequest[] = [], badges: Array<number | null> = [];
  const signals = new Signals({ toast: async request => { toasts.push(request); }, setBadge: async count => { badges.push(count); } }, () => preference, surface);
  return { signals, toasts, badges };
};

test('toasts: critical by default, all or off by preference, never a model name, clamped by the one sanitizer', () => {
  const lost = alert('runtime-lost', 'critical', 1, { runtime: 'omlx' }), unloaded = alert('model-unloaded', 'info', 2, { model: 'Private-Model-7B' });
  expect(toastFor(lost, 'critical')).toEqual({ kind: 'error', message: 'MLX Scope · oMLX stopped responding. Scope checks again automatically.', dismiss: true });
  expect(toastFor(unloaded, 'critical')).toBeNull();
  expect(toastFor(unloaded, 'all')?.message).toBe('MLX Scope · A model was unloaded. Reported by the runtime · Scope never loads models.');
  expect(toastFor(lost, 'off')).toBeNull();
  expect(toastFor({ ...lost, toastSeq: undefined }, 'all')).toBeNull();
  expect(JSON.stringify(toastFor(unloaded, 'all'))).not.toContain('Private-Model');
});

test('only the leader toasts, once per toastSeq; a handover never repeats the previous leader\'s toast', () => {
  const { signals, toasts } = recorder();
  const lost = alert('runtime-lost', 'critical', 1, { runtime: 'omlx' });
  signals.apply(snapshot([lost], false), []);
  expect(toasts).toHaveLength(0);
  signals.apply(snapshot([lost], true), []);
  expect(toasts).toHaveLength(0);
  signals.apply(snapshot([{ ...lost, toastSeq: 2 }], true), []);
  signals.apply(snapshot([{ ...lost, toastSeq: 2 }], true), []);
  expect(toasts).toHaveLength(1);
  // A frame that leads from its first snapshot toasts only what started just now.
  const fresh = recorder();
  fresh.signals.apply(snapshot([alert('pressure-critical', 'critical', 4, { level: 4 }), alert('runtime-lost', 'critical', 5, {}, MOCK_NOW - 60_000)]), []);
  expect(fresh.toasts.map(t => t.message)).toEqual(['MLX Scope · macOS memory pressure: critical. Reported by the macOS kernel · replies may slow sharply until memory frees up.']);
});

test('badge: the count of badge-eligible alerts, set by a leading page or status frame, cleared by a mounted panel', () => {
  expect(badgeCount([alert('thermal', 'warning'), { ...alert('omlx-memory-guard', 'warning'), badge: false }])).toBe(1);
  const status = recorder('status');
  status.signals.apply(snapshot([alert('thermal', 'warning'), alert('swap-growth', 'info')]), []);
  status.signals.apply(snapshot([alert('thermal', 'warning'), alert('swap-growth', 'info')]), []);
  status.signals.apply(snapshot([]), []);
  status.signals.apply(snapshot([alert('thermal', 'warning')], false), []);
  expect(status.badges).toEqual([2, null]);
  const panel = recorder('panel');
  panel.signals.panelMounted();
  panel.signals.apply(snapshot([alert('thermal', 'warning')]), []);
  expect(panel.badges).toEqual([null]);
});

test('badge: a visible panel that takes the lease over from the page clears the badge the page set', () => {
  const badges: Array<number | null> = [], host = { toast: async () => {}, setBadge: async (count: number | null) => { badges.push(count); } };
  const page = new Signals(host, () => 'critical', 'page'), panel = new Signals(host, () => 'critical', 'panel');
  const thermal = [alert('thermal', 'warning')];
  panel.panelMounted();
  panel.apply(snapshot(thermal), []);
  // The page opens over the still-visible rail panel and leads (SPIKES S1).
  page.apply(snapshot(thermal), []);
  panel.apply(snapshot(thermal, false), []);
  // The page closes; the panel leads again and keeps the rail icon clear through the alert's end.
  panel.apply(snapshot(thermal), []);
  panel.apply(snapshot([]), []);
  expect(badges).toEqual([null, 1, null]);
});
