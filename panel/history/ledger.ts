import type { HostClient } from '@openchamber/sdk';
import type { CompletionsV2, CompletionV2 } from '../../src/contract/completion.ts';
import type { LedgerAccounting } from './accounting.ts';
import type { LedgerAttr, LedgerRow, TurnRow } from './ledger-schema.ts';

// Owner: ledger. Leader-only writes (P9); flush at most every 5 min, at 50 pending rows, or on hide/pagehide (S5, G1),
// hide flushes ≥ 10 s apart; one `set` per flush plus the dictionary only when it changes; zero writes when idle.
// Eviction only after a flush (expired, then oldest); on HOST_REJECTED probe get('meta.v2'), never evict on an error.

export type LedgerStorage = HostClient['storage'];
export const FLUSH_EVERY_MS = 300_000;
export const FLUSH_ROWS = 50;
export const HIDE_FLUSH_GAP_MS = 10_000;
export const RETENTION_DAYS = { default: 30, max: 90 } as const;
export type FlushReason = 'completed' | 'hidden' | 'rows' | 'timer';
export type LedgerState = 'idle' | 'paused' | 'stopped' | 'backoff';
export interface LedgerOptions { storage: LedgerStorage; now: () => number; retentionDays?: number }

export class Ledger {
  constructor(private readonly options: LedgerOptions) {}
  get state(): LedgerState { return 'stopped'; }
  /** True until the first row is ever written: "Recording reply history locally · Open Scope to manage". */
  get firstRun(): boolean { return false; }
  /** Leader start or handover: reads meta and the persisted cursor, recomputes accounting. */
  async start(): Promise<void> { void this.options; }
  /** Rows from one poll's completions, deduped by (instance, seq); `reset` or a cursor jump records a gap row. */
  append(completions: CompletionsV2, label: (completion: CompletionV2) => LedgerAttr): void { void completions; void label; }
  appendTurn(row: TurnRow): void { void row; }
  /** Whether a flush is due now for this reason; the caller flushes (leader only). */
  due(reason: FlushReason, now: number): boolean { void reason; void now; return false; }
  async flush(reason: FlushReason): Promise<void> { void reason; }
  /** All rows in [fromS, toS], oldest first; reads chunk by chunk. */
  async read(fromS?: number, toS?: number): Promise<LedgerRow[]> { void fromS; void toS; return []; }
  /** The model label dictionary for in-view rendering (class B: never shared). */
  async models(): Promise<readonly string[]> { return []; }
  accounting(): LedgerAccounting | null { return null; }
  async setRetention(days: number): Promise<void> { void days; }
  setPaused(paused: boolean): void { void paused; }
  /** Deletes every ledger.v2.* key and baseline.v2 (after the UI's confirmation). */
  async clear(): Promise<void> {}
  dispose(): void {}
}
