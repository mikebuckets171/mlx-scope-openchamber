// Synthetic History and Captures preview (ui-history): the real views, mounted with the approved mock's data behind the
// same interfaces the shell passes (docs/2.0/INTERFACES.md §4.3–4.4). Nothing here talks to a runtime or the host.
import type { HostClient } from '@openchamber/sdk';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import type { NextReplyState } from '../../panel/attribution/next-reply.ts';
import type { CaptureV2 } from '../../panel/captures/store.ts';
import type { LedgerRow } from '../../panel/history/ledger-schema.ts';
import type { LedgerState } from '../../panel/history/ledger.ts';
import { capturesView } from '../../panel/render/views/captures.ts';
import { historyView } from '../../panel/render/views/history.ts';
import type { ViewHandle } from '../../panel/render/views/types.ts';
import { MOCK_TEXT } from '../../panel/testing/history-text.ts';
import { MOCK_MODELS, MOCK_NOW, mockAccounting, mockLedgerRows, mockSnapshot, mockTrend, mockUsage } from '../../panel/testing/mock-history.ts';

const params = new URLSearchParams(location.search);
const tab = params.get('tab') === 'captures' ? 'captures' : 'history', state = params.get('state') ?? 'decode', page = params.get('surface') === 'page';
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
const empty = state === 'history-empty';

// A controllable service clock and recorders the tests read back.
const harness = {
  now: MOCK_NOW, copied: '', composed: '', watched: 0, retention: [] as number[], paused: [] as boolean[], cleared: 0, trendReads: [] as number[], usageReads: [] as string[],
  saved: [] as CaptureV2[], ledgerState: (params.has('stopped') ? 'stopped' : state === 'recording-paused' ? 'paused' : 'idle') as LedgerState,
  next: null as NextReplyState | null, handle: null as ViewHandle | null, snapshot: null as SnapshotV2 | null,
  push(snapshot: SnapshotV2): void { this.snapshot = snapshot; this.handle!.update(snapshot); },
  /** One decode poll `ms` after the mock's now, with `tokens` output so far (the window capture's input). */
  decode(ms: number, tokens: number): void {
    const s = structuredClone(base);
    s.serverNow = MOCK_NOW + ms; s.runtime.sampledAt = MOCK_NOW + ms;
    s.runtime.request = { ...s.runtime.request!, outputTokens: tokens, elapsedMs: 60_000 + ms };
    if (s.host) s.host = { ...s.host, sampledAt: MOCK_NOW + ms };
    this.now = MOCK_NOW + ms; this.push(s);
  },
  setNext(next: NextReplyState | null): void { this.next = next; this.handle!.update(this.snapshot); },
};
(window as unknown as { harness: typeof harness }).harness = harness;

const base = mockSnapshot(state);
if (empty) base.alertLog = [];
let rows: LedgerRow[] = empty ? [] : mockLedgerRows();
const storage = new Map<string, unknown>();
const host = {
  storage: { get: async (key: string) => storage.get(key) as never, set: async (key: string, value: unknown) => { storage.set(key, value); },
    delete: async (key: string) => { storage.delete(key); }, keys: async () => [...storage.keys()] },
  writeClipboard: async (text: string) => { if (params.get('clipboard') === 'fail') throw new Error('refused'); harness.copied = text; },
  compose: async ({ text }: { text: string }) => { harness.composed = text; },
  onSession: (listener: (session: unknown) => void) => { listener(params.has('chat') ? { id: 'synthetic', title: 'never shown', busy: false } : null); return () => {}; },
} as unknown as HostClient;
const context = { host, surface: (page ? 'page' : 'panel') as 'page' | 'panel', now: () => harness.now, visible: () => true, leader: () => true };

const initialNext = (): NextReplyState | null => {
  if (state === 'next-armed') return { kind: 'armed', at: MOCK_NOW - 12_000 };
  if (state === 'next-measuring') return { kind: 'measuring', startedAt: MOCK_NOW - 38_200, steps: [] };
  if (state === 'next-result') return { kind: 'result', startedAt: MOCK_NOW - 47_000, endedAt: MOCK_NOW - 9_000, attributed: true, summary: null, steps: [
    { seq: 41, finishedAt: MOCK_NOW - 30_000, startedAt: MOCK_NOW - 47_000, model: 'Example-27B-4bit', basis: 'last-observed', outputTokens: 604, decodeTps: 25.6, overlapped: false, host: {} },
    { seq: 42, finishedAt: MOCK_NOW - 9_000, startedAt: MOCK_NOW - 24_000, model: 'Example-27B-4bit', basis: 'last-observed', outputTokens: 600, decodeTps: 24.7, overlapped: false, host: {} }] };
  if (state === 'other-provider') return { kind: 'offer-watch', runtime: 'Splash' };
  return { kind: 'idle' };
};
harness.next = initialNext();

const legacy: CaptureV2[] = params.has('legacy') ? [
  { v: 2, savedAt: MOCK_NOW - 3 * 86_400_000, kind: 'window', runtime: 'omlx', label: 'server-wide', state: 'finished', measurements: { observedGeneration: 23.9, windowMs: 60_000 } },
  { v: 2, savedAt: MOCK_NOW - 4 * 86_400_000, kind: 'snapshot', runtime: null, label: 'server-wide', state: 'finished', measurements: { generation: 22.4 } }] : [];
// The mock's three saved captures, as capture.v2 holds them: runtime kinds, never model names.
harness.saved = params.get('saved') === 'none' ? [] : [
  { v: 2, savedAt: 1_790_689_380_000, kind: 'next-reply', runtime: 'omlx', label: 'armed', state: 'finished', measurements: { decodeTps: 25.1, decodeBasis: 0, outputTokens: 1204 } },
  { v: 2, savedAt: 1_790_679_900_000, kind: 'window', runtime: 'omlx', label: 'server-wide', state: 'finished', measurements: { decodeTps: 24.6, decodeBasis: 2, outputTokens: 1480, windowMs: 60_000 } },
  { v: 2, savedAt: 1_790_597_100_000, kind: 'window', runtime: 'omlx', label: 'server-wide', state: 'finished', measurements: { decodeTps: 61.3, decodeBasis: 2, outputTokens: 1830, windowMs: 30_000 } }];

const root = document.getElementById(page ? 'history-column' : `panel-${tab}`)!;
harness.handle = tab === 'captures' && !page ? capturesView({
  store: { list: async () => harness.saved.map(capture => ({ ...capture, key: `capture.v2.${capture.savedAt.toString(36)}` })), save: async capture => { harness.saved = [capture, ...harness.saved].slice(0, 12); return `capture.v2.${capture.savedAt.toString(36)}`; } },
  legacy: async () => legacy, copy: text => host.writeClipboard(text), compose: text => host.compose({ text, mode: 'append' }), version: '2.0.0',
  next: params.get('next') === 'none' ? null : { state: () => harness.next ?? { kind: 'idle' }, arm: () => { harness.next = { kind: 'armed', at: harness.now }; }, cancel: () => { harness.next = { kind: 'cancelled', reason: 'user' }; },
    watch: () => { harness.watched += 1; } },
  forbidden: () => MOCK_MODELS, text: MOCK_TEXT,
})(root, context) : historyView({
  ledger: {
    get state() { return harness.ledgerState; },
    read: async () => rows, models: async () => MOCK_MODELS,
    accounting: () => empty ? { ...mockAccounting(), ledgerBytes: 2048, oldestS: null } : mockAccounting(state === 'storage-full'),
    setRetention: async days => { harness.retention.push(days); }, setPaused: paused => { harness.paused.push(paused); harness.ledgerState = paused ? 'paused' : 'idle'; },
    clear: async () => { harness.cleared += 1; rows = []; },
  },
  client: {
    trend: async request => { harness.trendReads.push(request.windowMs); return { ok: true, body: mockTrend(request.windowMs, empty) }; },
    usage: async request => { harness.usageReads.push(request.range); return { ok: true, body: mockUsage(request.range) }; },
  },
  retentionDays: () => 30, paused: () => state === 'recording-paused', copy: text => host.writeClipboard(text), version: '2.0.0', text: MOCK_TEXT, legacyCaptures: async () => empty ? 3 : 0,
})(root, context);
harness.push(base);
document.body.dataset.ready = 'true';
