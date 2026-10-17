import { chunkStartS, KEYS, parseRow } from './ledger-schema.ts';

// Owner: ledger. Exact client-side accounting of the storage namespace (serialized size and key count), recomputed at
// leader start and updated per write. Host limits: 64 KiB per value, 2 MiB and 2,000 keys per extension.

export const STORAGE_LIMITS = { valueBytes: 64 * 1024, totalBytes: 2 * 1024 * 1024, keys: 2_000 } as const;
export const LEDGER_CAP_BYTES = 1_280 * 1024;
export const HEADROOM_BYTES = 128 * 1024;
/** Keys kept free for captures, preferences and 1.x keys, as the byte headroom is. */
export const HEADROOM_KEYS = 64;
export interface LedgerAccounting {
  totalBytes: number; keys: number; ledgerBytes: number; capBytes: number; oldestS: number | null;
  /** Captures and 1.x saves from earlier versions: kept untouched and still counted, never shown or written now. */
  keptItems?: number; keptBytes?: number;
}

const encoder = new TextEncoder();
export const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;
/**
 * The bytes one key/value adds to the namespace file, as the host serializes it: `"key":value,` (UTF-8). The file is
 * `{` + entries + `}`, so a namespace is 1 + Σ entries (the last comma stands for `}`), or 2 bytes when empty.
 */
export const entryBytes = (key: string, value: unknown): number => jsonBytes(key) + jsonBytes(value) + 2;
export const isLedgerKey = (key: string): boolean => key.startsWith('ledger.v2.') || key === KEYS.baseline;
export const isKeptKey = (key: string): boolean => key.startsWith(KEYS.capturePrefix) || key.startsWith(KEYS.legacyObservationPrefix);

/** The oldest row time in a stored chunk value, without keeping its rows. */
export const chunkOldestS = (key: string, value: unknown): number | null => {
  const rows = value !== null && typeof value === 'object' && Array.isArray((value as { r?: unknown }).r) ? (value as { r: unknown[] }).r : [];
  let oldest: number | null = null;
  for (const raw of rows) { const row = parseRow(raw); if (row) oldest = Math.min(oldest ?? Infinity, row[1]); }
  return oldest ?? (rows.length ? null : chunkStartS(key));
};

export class Accounting {
  readonly #sizes = new Map<string, number>();
  readonly #oldest = new Map<string, number>();
  #sum = 0;
  #ledger = 0;
  #kept = 0;
  #keptItems = 0;
  readonly #capBytes: number;
  constructor(capBytes: number = LEDGER_CAP_BYTES) { this.#capBytes = capBytes;}
  recompute(entries: ReadonlyArray<readonly [string, unknown]>): LedgerAccounting {
    this.#sizes.clear(); this.#oldest.clear(); this.#sum = 0; this.#ledger = 0; this.#kept = 0; this.#keptItems = 0;
    for (const [key, value] of entries) if (value !== undefined) this.#put(key, value);
    return this.view();
  }
  /** Applies one set/delete; `after` undefined = delete. */
  apply(key: string, before: unknown, after: unknown): LedgerAccounting {
    void before;                             // the recorded size is exact; `before` only documents the call site
    this.#remove(key);
    if (after !== undefined) this.#put(key, after);
    return this.view();
  }
  /** Whether adding `bytes` keeps the ledger under its cap and the namespace ≥ 128 KiB under 2 MiB. */
  fits(bytes: number, keys = 0): boolean {
    return this.#ledger + bytes <= this.#capBytes && this.#total + bytes <= STORAGE_LIMITS.totalBytes - HEADROOM_BYTES
      && this.#sizes.size + keys <= STORAGE_LIMITS.keys - HEADROOM_KEYS;
  }
  /** Whether the host would take it at all: the hard 2 MiB / 2,000-key limits. */
  hostFits(bytes: number, keys = 0): boolean {
    return this.#total + bytes <= STORAGE_LIMITS.totalBytes && this.#sizes.size + keys <= STORAGE_LIMITS.keys;
  }
  size(key: string): number { return this.#sizes.get(key) ?? 0; }
  keyList(): string[] { return [...this.#sizes.keys()]; }
  has(key: string): boolean { return this.#sizes.has(key); }
  view(): LedgerAccounting {
    let oldestS: number | null = null;
    for (const value of this.#oldest.values()) oldestS = Math.min(oldestS ?? Infinity, value);
    return { totalBytes: this.#total, keys: this.#sizes.size, ledgerBytes: this.#ledger, capBytes: this.#capBytes, oldestS,
      keptItems: this.#keptItems, keptBytes: this.#kept };
  }
  get #total(): number { return this.#sizes.size ? this.#sum + 1 : 2; }
  #put(key: string, value: unknown): void {
    const size = entryBytes(key, value);
    this.#sizes.set(key, size); this.#sum += size;
    if (isLedgerKey(key)) this.#ledger += size;
    if (isKeptKey(key)) { this.#kept += size; this.#keptItems += 1; }
    if (key.startsWith(KEYS.chunkPrefix)) { const oldestS = chunkOldestS(key, value); if (oldestS !== null) this.#oldest.set(key, oldestS); }
  }
  #remove(key: string): void {
    const size = this.#sizes.get(key);
    if (size === undefined) return;
    this.#sizes.delete(key); this.#oldest.delete(key); this.#sum -= size;
    if (isLedgerKey(key)) this.#ledger -= size;
    if (isKeptKey(key)) { this.#kept -= size; this.#keptItems -= 1; }
  }
}
