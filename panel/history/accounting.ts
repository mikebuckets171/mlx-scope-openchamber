// Owner: ledger. Exact client-side accounting of the storage namespace (serialized size and key count), recomputed at
// leader start and updated per write. Host limits: 64 KiB per value, 2 MiB and 2,000 keys per extension.

export const STORAGE_LIMITS = { valueBytes: 64 * 1024, totalBytes: 2 * 1024 * 1024, keys: 2_000 } as const;
export const LEDGER_CAP_BYTES = 1_280 * 1024;
export const HEADROOM_BYTES = 128 * 1024;
export interface LedgerAccounting { totalBytes: number; keys: number; ledgerBytes: number; capBytes: number; oldestS: number | null }
/** The bytes one key/value adds to the namespace file, as the host serializes it. */
export const entryBytes = (key: string, value: unknown): number => { void key; void value; return 0; };
export class Accounting {
  recompute(entries: ReadonlyArray<readonly [string, unknown]>): LedgerAccounting { void entries; throw new Error('Accounting: not implemented (ledger)'); }
  /** Applies one set/delete; `after` undefined = delete. */
  apply(key: string, before: unknown, after: unknown): LedgerAccounting { void key; void before; void after; throw new Error('Accounting: not implemented (ledger)'); }
  /** Whether adding `bytes` keeps the ledger under its cap and the namespace ≥ 128 KiB under 2 MiB. */
  fits(bytes: number): boolean { void bytes; return false; }
}
