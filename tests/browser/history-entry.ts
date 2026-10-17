// Synthetic History preview (ui-history): the real view, mounted with the approved mock's data behind the
// same interfaces the shell passes (docs/2.0/INTERFACES.md §4.3–4.4). Nothing here talks to a runtime or the host.
import type { HostClient } from '@openchamber/sdk';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import type { LedgerRow } from '../../panel/history/ledger-schema.ts';
import type { LedgerState } from '../../panel/history/ledger.ts';
import { historyView } from '../../panel/render/views/history.ts';
import type { ViewHandle } from '../../panel/render/views/types.ts';
import { ICON } from '../../panel/render/views/parts.ts';
import { withheldWhy, alertCopy } from '../../panel/present/copy.ts';
const MOCK_TEXT = { withheld: (reason: string) => `All server activity · ${withheldWhy(reason)}`, alert: (id: Parameters<typeof alertCopy>[0], params: Parameters<typeof alertCopy>[1]) => alertCopy(id, params)[0] };
import { MOCK_MODELS, MOCK_NOW, mockAccounting, mockLedgerRows, mockSnapshot, mockTrend, mockUsage } from '../../panel/testing/mock-history.ts';

const params = new URLSearchParams(location.search);
document.querySelector('.brand')!.insertAdjacentHTML('afterbegin', ICON.mark.markup);
const state = params.get('state') ?? 'decode', page = params.get('surface') === 'page';
const empty = state === 'history-empty';

// A controllable service clock and recorders the tests read back.
const harness = {
  now: MOCK_NOW, copied: '', composed: '', retention: [] as number[], paused: [] as boolean[], cleared: 0, trendReads: [] as number[], usageReads: [] as string[],
  autoLabel: [] as boolean[], ledgerState: (params.has('stopped') ? 'stopped' : state === 'recording-paused' ? 'paused' : 'idle') as LedgerState,
  handle: null as ViewHandle | null, snapshot: null as SnapshotV2 | null,
  push(snapshot: SnapshotV2): void { this.snapshot = snapshot; this.handle!.update(snapshot); },
  /** One decode poll `ms` after the mock's now, with `tokens` output so far (the window capture's input). */
  decode(ms: number, tokens: number): void {
    const s = structuredClone(base);
    s.serverNow = MOCK_NOW + ms; s.runtime.sampledAt = MOCK_NOW + ms;
    s.runtime.request = { ...s.runtime.request!, outputTokens: tokens, elapsedMs: 60_000 + ms };
    if (s.host) s.host = { ...s.host, sampledAt: MOCK_NOW + ms };
    this.now = MOCK_NOW + ms; this.push(s);
  },
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

const root = document.getElementById(page ? 'history-column' : 'panel-history')!;
harness.handle = historyView({
  ledger: {
    get state() { return harness.ledgerState; },
    read: async () => rows, models: async () => MOCK_MODELS,
    accounting: () => empty ? { ...mockAccounting(), ledgerBytes: 2048, oldestS: null } : mockAccounting(state === 'storage-full'),
    setRetention: async days => { harness.retention.push(days); }, setPaused: paused => { harness.paused.push(paused); harness.ledgerState = paused ? 'paused' : 'idle'; },
    clear: async () => { harness.cleared += 1; rows = []; },
  },
  client: {
    trend: async request => { harness.trendReads.push(request.windowMs); return { ok: true, body: mockTrend(request.windowMs, empty) }; },
    usage: async request => { harness.usageReads.push(request.range); const body = mockUsage(request.range); if (params.get('usage') === 'totals-only') body.buckets = []; return { ok: true, body }; },
  },
  retentionDays: () => 30, paused: () => state === 'recording-paused', copy: text => host.writeClipboard(text), version: '2.0.0', text: MOCK_TEXT,
  autoLabel: () => true, setAutoLabel: async value => { harness.autoLabel.push(value); },
})(root, context);
harness.push(base);
document.body.dataset.ready = 'true';
