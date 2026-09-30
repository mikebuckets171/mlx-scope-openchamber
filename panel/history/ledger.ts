import type { HostClient, JsonValue } from '@openchamber/sdk';
import { MAX_COMPLETIONS, type CompletionsV2, type CompletionV2 } from '../../src/contract/completion.ts';
import { modelLabel } from '../../src/contract/guards.ts';
import type { RuntimeKind } from '../../src/contract/runtime.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import { Accounting, entryBytes, isLedgerKey, jsonBytes, type LedgerAccounting } from './accounting.ts';
import { BASELINE_WINDOW_MS, BASELINE_WRITE_MS, buildBaselines, parseBaselineStore, sameBaselines, toBaselineStore, type Baselines } from './baselines.ts';
import {
  CHUNK_KEY, CHUNK_MAX_CHARS, CHUNK_TARGET_CHARS, chunkKey, KEYS, LEDGER_SCHEMA, MAX_CURSORS, MAX_MODELS, parseChunk, parseCursors, parseMeta,
  parseModels, parsePref, rand4, replyRow, retentionDays, rowIdentity, rowTimeS, toSeconds, verdictAttr,
  type ChunkV2, type LedgerAttr, type LedgerCursor, type LedgerMeta, type LedgerRow, type ReplyRow, type TurnRow,
} from './ledger-schema.ts';
import { migrateV1 } from './migrate-v1.ts';
import { PrefStore } from './prefs.ts';

// Owner: ledger. Leader-only writes (P9); flush at most every 5 min, at 50 pending rows, or on hide/pagehide (S5, G1),
// hide flushes ≥ 10 s apart; one `set` per flush plus the dictionary only when it changes; zero writes when idle.
// Eviction only after a flush (expired, then oldest); on HOST_REJECTED probe get('meta.v2'), never evict on an error.

export type LedgerStorage = HostClient['storage'];
export const FLUSH_EVERY_MS = 300_000;
export const FLUSH_ROWS = 50;
export const HIDE_FLUSH_GAP_MS = 10_000;
export const RETENTION_DAYS = { default: 30, max: 90 } as const;
/** Completions this recent are re-delivered (`since` held back) so a verdict another frame posts still reaches the row. */
export const VERDICT_HOLD_MS = 30_000;
/** …and never more than this many, so re-deliveries cannot crowd a 64-item page. */
export const VERDICT_HOLD_ITEMS = 16;
export const BACKOFF_MS = { first: 30_000, max: FLUSH_EVERY_MS } as const;
/** Reply ids remembered for dedupe: more than the service ring (128 per slot) can re-deliver. */
const RECENT_IDS = 2_048;
export const CHUNK_SPAN_S = 86_400;
export type FlushReason = 'completed' | 'hidden' | 'rows' | 'timer';
export type LedgerState = 'idle' | 'paused' | 'stopped' | 'backoff';
export interface LedgerOptions { storage: LedgerStorage; now: () => number; retentionDays?: number; random?: () => string }
/** Which connection a poll's completions came from; `since` is the cursor the poll sent, when the caller knows it. */
export interface LedgerSource { connection: string; rt: RuntimeKind; since?: number | undefined }
/** The History → Storage card. */
export interface LedgerUsage {
  ledgerBytes: number; capBytes: number; namespaceBytes: number; keys: number; replies: number; days: number;
  retentionDays: number; paused: boolean; oldestS: number | null;
}

interface ChunkInfo { key: string; oldestS: number; newestS: number; replies: number }
interface Pending { row: LedgerRow; connection: string | null; cursor: LedgerCursor | null }
interface OpenChunk { key: string; rows: LedgerRow[]; verified: boolean }
type Entries = Array<[string, unknown]>;

const isChunkKey = (key: string): boolean => CHUNK_KEY.test(key);
const chunkValue = (rows: readonly LedgerRow[], cursors: ReadonlyMap<string, LedgerCursor>): ChunkV2 => ({ v: LEDGER_SCHEMA, c: Object.fromEntries(cursors), r: [...rows] });
const infoOf = (key: string, rows: readonly LedgerRow[]): ChunkInfo => ({ key, oldestS: Math.min(...rows.map(row => row[1])),
  newestS: Math.max(...rows.map(rowTimeS)), replies: rows.filter(row => row[0] === 'r').length });
const newer = (a: LedgerCursor, b: LedgerCursor): boolean => a[2] > b[2] || a[2] === b[2] && a[1] > b[1];
/** Newest `MAX_CURSORS` connections by read time: a namespace never grows with connections that went away. */
const bounded = (cursors: Map<string, LedgerCursor>): Map<string, LedgerCursor> =>
  new Map([...cursors].sort(([, a], [, b]) => b[2] - a[2]).slice(0, MAX_CURSORS));
const dayS = 86_400;

export class Ledger {
  private stateValue: LedgerState = 'stopped';
  private readonly book = new Accounting();
  private readonly prefs: PrefStore;
  private readonly chunks = new Map<string, ChunkInfo>();
  private open: OpenChunk | null = null;
  private pending: Pending[] = [];
  private readonly cursors = new Map<string, LedgerCursor>();       // consumed
  private persisted = new Map<string, LedgerCursor>();              // acknowledged in storage
  private readonly resync = new Map<string, number>();             // connection → gap start after a service restart
  private recent: Array<{ connection: string; instance: string; seq: number; finishedAt: number }> = [];
  private readonly seen = new Set<string>();
  private readonly mutable = new Map<string, ReplyRow>();           // reply rows a flush still rewrites: pending + open chunk
  private relabeled = false;
  private modelList: string[] = [];
  private readonly modelIndex = new Map<string, number>();
  private modelsDirty = false;
  private clearedAt = 0;
  private retention: number;
  private paused = false;
  /** The last `pref.v2` this ledger saw, so a flush applies another frame's change without undoing a local one in flight. */
  private prefSeen = '';
  private lastFlushAt = 0;
  private lastHideFlushAt = -Infinity;
  private retryAt = 0;
  private failures = 0;
  private stale = false;
  private first = false;
  private baselineAt = -Infinity;
  private stored: Baselines | null = null;
  private flushing: Promise<void> | null = null;
  private epoch = 0;

  constructor(private readonly options: LedgerOptions) {
    this.retention = retentionDays(options.retentionDays) ?? RETENTION_DAYS.default;
    this.prefs = new PrefStore(options.storage);
  }
  get state(): LedgerState { return this.stateValue; }
  /** True until the first row is ever written: "Recording reply history locally · Open Scope to manage". */
  get firstRun(): boolean { return this.first; }
  /** Rows appended and not yet written. */
  get pendingRows(): number { return this.pending.length; }

  /** Leader start or handover: reads meta and the persisted cursor, recomputes accounting. Writes nothing (the one-time 1.x migration aside). */
  async start(): Promise<void> {
    const epoch = ++this.epoch;
    this.reset();
    try {
      let entries = await this.entries();
      if (epoch !== this.epoch) return;
      const meta = parseMeta(new Map(entries).get(KEYS.meta));
      if (!meta?.migratedAt && entries.some(([key]) => key.startsWith(KEYS.legacyObservationPrefix))) {
        // A failed migration is retried at the next start; it never keeps the ledger from recording.
        await migrateV1(this.options.storage, this.options.now()).catch(() => undefined);
        entries = await this.entries();
        if (epoch !== this.epoch) return;
      }
      this.load(entries);
      this.lastFlushAt = this.options.now();
      this.stateValue = this.paused ? 'paused' : 'idle';
    } catch {
      if (epoch === this.epoch) this.stateValue = 'stopped';
    }
  }

  /** Rows from one poll's completions, deduped by (instance, seq); `reset` or a cursor jump records a gap row. */
  append(completions: CompletionsV2, label: (completion: CompletionV2) => LedgerAttr, source: LedgerSource): void {
    if (this.stateValue === 'stopped') return;
    const { connection, rt } = source, prior = this.cursors.get(connection), instance = completions.instance;
    // A poll sent with a cursor ahead of ours skipped what we have not acknowledged; the next poll sends ours.
    if (prior && prior[0] === instance && 'since' in source && source.since !== undefined && source.since > prior[1]) return;
    if (prior && prior[0] !== instance) {
      // The service restarted: its old ring is gone. Re-read the new ring from its start before recording anything.
      this.resync.set(connection, this.resync.get(connection) ?? prior[2]);
      this.cursors.set(connection, [instance, 0, prior[2]]);
      return;
    }
    const nowS = toSeconds(this.options.now());
    let gapFrom = this.resync.get(connection) ?? (completions.reset && prior ? prior[2] : null);
    this.resync.delete(connection);
    let cursor: LedgerCursor = prior ?? [instance, 0, 0];
    for (const item of completions.items) {
      const id = `${instance}.${item.seq}`, attr = label(item);
      if (this.seen.has(id)) { this.relabel(id, attr); continue; }
      const finishedS = toSeconds(item.finishedAt);
      this.remember(id);
      this.recent.push({ connection, instance, seq: item.seq, finishedAt: item.finishedAt });
      // A gap row carries the cursor from before its reply, so a flush that ends on it never acknowledges that reply.
      if (gapFrom !== null) { if (finishedS > gapFrom) this.push(['g', gapFrom, finishedS], connection, cursor); gapFrom = null; }
      cursor = [instance, Math.max(cursor[1], item.seq), Math.max(cursor[2], finishedS)];
      if (this.paused || item.finishedAt < this.clearedAt) continue;
      this.push(replyRow(item, instance, rt, this.modelRef(item.model), attr), connection, cursor);
    }
    if (gapFrom !== null && nowS > gapFrom) this.push(['g', gapFrom, nowS], connection, cursor);
    // ≤ 64 items per response: a short page means everything up to the ring's cursor was delivered.
    const end = completions.items.length < MAX_COMPLETIONS ? completions.cursor : cursor[1];
    // A first contact with an empty ring has read it through now.
    this.cursors.set(connection, [instance, Math.max(cursor[1], end), cursor[2] || nowS]);
    const keepFrom = this.options.now() - 4 * VERDICT_HOLD_MS;
    if (this.recent.length > MAX_COMPLETIONS) this.recent = this.recent.filter(item => item.finishedAt >= keepFrom).slice(-MAX_COMPLETIONS);
  }
  /** A turn row (attribution's summary); it links the attributed replies it spans. */
  appendTurn(row: TurnRow): void {
    if (this.stateValue === 'stopped' || this.paused || row[2] * 1000 < this.clearedAt) return;
    const identity = rowIdentity(row);
    for (const reply of this.mutable.values()) {
      if (reply[2] === row[3] && reply[1] >= row[1] && reply[1] <= row[2] && reply[14] === null && (reply[13] === 'inferred' || reply[13] === 'armed')) {
        reply[14] = row[1]; this.relabeled = true;
      }
    }
    const index = this.pending.findIndex(entry => rowIdentity(entry.row) === identity);
    if (index >= 0) { this.pending[index]!.row = row; return; }
    const stored = this.open?.rows.findIndex(item => rowIdentity(item) === identity) ?? -1;
    if (stored >= 0) { this.open!.rows[stored] = row; this.relabeled = true; return; }
    this.push(row, null, null);
  }
  /** The dictionary index for a model name (class B: stored locally, never shared); null past the dictionary cap. */
  modelRef(raw: string | null): number | null {
    // A name, never a path: the wire parser already strips one; a caller's raw string gets the same treatment.
    const name = modelLabel(raw);
    if (!name) return null;
    const known = this.modelIndex.get(name);
    if (known !== undefined) return known;
    if (this.modelList.length >= MAX_MODELS) return null;
    this.modelIndex.set(name, this.modelList.length);
    this.modelList.push(name);
    this.modelsDirty = true;
    return this.modelList.length - 1;
  }
  /** The `since` a leader's next poll sends: the acknowledged cursor, held back over the last 30 s of completions. */
  since(connection: string, now = this.options.now()): number | undefined {
    const cursor = this.cursors.get(connection);
    if (this.stateValue === 'stopped' || !cursor) return undefined;
    let since = cursor[1];
    for (const item of this.recent) {
      if (item.connection === connection && item.instance === cursor[0] && now - item.finishedAt <= VERDICT_HOLD_MS) since = Math.min(since, item.seq - 1);
    }
    return Math.max(since, cursor[1] - VERDICT_HOLD_ITEMS);
  }

  /** Whether a flush is due now for this reason; the caller flushes (leader only). */
  due(reason: FlushReason, now: number): boolean {
    if (this.stateValue === 'stopped' || this.flushing || now < this.retryAt || !this.pending.length && !this.relabeled) return false;
    if (reason === 'rows') return this.pending.length >= FLUSH_ROWS;
    if (reason === 'hidden') return now - this.lastHideFlushAt >= HIDE_FLUSH_GAP_MS;
    return now - this.lastFlushAt >= FLUSH_EVERY_MS;
  }
  flush(reason: FlushReason): Promise<void> {
    if (this.stateValue === 'stopped') return Promise.resolve();
    this.flushing ??= this.write(reason).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  /** All rows in [fromS, toS], oldest first; reads chunk by chunk. Rows past retention are left out. */
  async read(fromS = 0, toS = Infinity): Promise<LedgerRow[]> {
    const running = this.stateValue !== 'stopped';
    const retention = running ? this.retention : parsePref(await this.options.storage.get(KEYS.pref)).retentionDays;
    const floorS = Math.max(fromS, toSeconds(this.options.now()) - retention * dayS);
    const keys = running ? [...this.chunks.values()].filter(chunk => chunk.newestS >= floorS && chunk.oldestS <= toS).map(chunk => chunk.key)
      : (await this.options.storage.keys()).filter(isChunkKey);
    const rows = new Map<string, LedgerRow>();
    const take = (row: LedgerRow): void => { const time = rowTimeS(row); if (time >= floorS && time <= toS) rows.set(rowIdentity(row), row); };
    for (const key of keys) for (const row of parseChunk(await this.options.storage.get(key))?.r ?? []) take(row);
    if (running) { for (const row of this.open?.rows ?? []) take(row); for (const { row } of this.pending) take(row); }
    return [...rows.values()].sort((a, b) => rowTimeS(a) - rowTimeS(b) || a[1] - b[1]);
  }
  /** The model label dictionary for in-view rendering (class B: never shared). */
  async models(): Promise<readonly string[]> {
    return this.stateValue !== 'stopped' ? [...this.modelList] : parseModels(await this.options.storage.get(KEYS.models));
  }
  accounting(): LedgerAccounting | null { return this.stateValue === 'stopped' ? null : this.book.view(); }
  usage(): LedgerUsage | null { return this.stateValue === 'stopped' ? null : this.usageOf(this.book, this.chunks.values()); }
  /** Read-only accounting for a frame that is not recording (the Storage card in any view). */
  async inspect(): Promise<LedgerUsage> {
    const entries = await this.entries(), book = new Accounting(), infos: ChunkInfo[] = [];
    book.recompute(entries);
    for (const [key, value] of entries) {
      const rows = isChunkKey(key) ? parseChunk(value)?.r : undefined;
      if (rows?.length) infos.push(infoOf(key, rows));
    }
    const pref = parsePref(new Map(entries).get(KEYS.pref));
    return { ...this.usageOf(book, infos), retentionDays: pref.retentionDays, paused: !pref.history };
  }
  /** The persisted baselines (`baseline.v2`), for any frame; null before the leader first writes them. */
  async storedBaselines(): Promise<Baselines | null> {
    if (this.stateValue !== 'stopped' && this.stored) return this.stored;
    return parseBaselineStore(await this.options.storage.get(KEYS.baseline))?.baselines ?? null;
  }
  async computeBaselines(now = this.options.now()): Promise<Baselines> {
    const rows = await this.read(toSeconds(now - BASELINE_WINDOW_MS));
    return buildBaselines(rows.filter((row): row is ReplyRow => row[0] === 'r'), now);
  }
  /** Persists `pref.v2.retentionDays`; expired chunks go at the leader's next flush (eviction only after a flush). */
  async setRetention(days: number): Promise<void> {
    const value = retentionDays(days) ?? RETENTION_DAYS.default;
    await this.prefs.update({ retentionDays: value });
    this.retention = value;
  }
  /** "Pause recording": no new rows (rows already pending still flush). Persisted to `pref.v2.history`. */
  setPaused(paused: boolean): void {
    this.setPausedLocal(paused);
    void this.prefs.update({ history: !paused }).catch(() => undefined);
  }
  /** Deletes every ledger.v2.* key and baseline.v2 (after the UI's confirmation). */
  async clear(): Promise<void> {
    const now = this.options.now(), storage = this.options.storage;
    const meta: LedgerMeta = { ...parseMeta(await storage.get(KEYS.meta)) ?? { schema: LEDGER_SCHEMA, migratedAt: null, accounting: { bytes: 0, keys: 0 } }, clearedAt: now };
    // clearedAt first: whichever frame leads next never re-records a cleared reply from the service ring.
    await storage.set(KEYS.meta, meta as unknown as JsonValue);
    this.book.apply(KEYS.meta, undefined, meta);
    for (const key of (await storage.keys()).filter(isLedgerKey)) { await storage.delete(key); this.book.apply(key, undefined, undefined); }
    this.applyClear(now);
  }
  dispose(): void {
    this.epoch += 1;
    this.reset();
    this.stateValue = 'stopped';
  }

  private reset(): void {
    this.chunks.clear(); this.open = null; this.pending = []; this.cursors.clear(); this.persisted = new Map(); this.resync.clear();
    this.recent = []; this.seen.clear(); this.mutable.clear(); this.relabeled = false; this.modelList = []; this.modelIndex.clear();
    this.modelsDirty = false; this.clearedAt = 0; this.retryAt = 0; this.failures = 0; this.stale = false; this.first = false;
    this.stored = null; this.baselineAt = -Infinity; this.lastHideFlushAt = -Infinity; this.book.recompute([]);
  }
  private async entries(): Promise<Entries> {
    const storage = this.options.storage, keys = await storage.keys();
    return Promise.all(keys.map(async key => [key, await storage.get(key)] as [string, unknown]));
  }
  private load(entries: Entries): void {
    const values = new Map(entries), meta = parseMeta(values.get(KEYS.meta)), pref = parsePref(values.get(KEYS.pref));
    this.book.recompute(entries);
    this.clearedAt = meta?.clearedAt ?? 0;
    this.retention = retentionDays(this.options.retentionDays) ?? pref.retentionDays;
    this.paused = !pref.history;
    this.prefSeen = JSON.stringify(pref);
    this.modelList = parseModels(values.get(KEYS.models));
    this.modelList.forEach((name, index) => { if (name && !this.modelIndex.has(name)) this.modelIndex.set(name, index); });
    const baseline = parseBaselineStore(values.get(KEYS.baseline));
    if (baseline) { this.stored = baseline.baselines; this.baselineAt = baseline.computedAt; }
    const parsed: Array<[string, ChunkV2]> = [];
    for (const [key, value] of entries) {
      const chunk = isChunkKey(key) ? parseChunk(value) : null;
      if (!chunk) continue;
      parsed.push([key, chunk]);
      if (chunk.r.length) this.chunks.set(key, infoOf(key, chunk.r));
      for (const [connection, cursor] of parseCursors(chunk.c)) {
        const known = this.persisted.get(connection);
        if (!known || newer(cursor, known)) this.persisted.set(connection, cursor);
      }
    }
    for (const [connection, cursor] of this.persisted) this.cursors.set(connection, cursor);
    const byAge = parsed.filter(([key]) => this.chunks.has(key)).sort(([a], [b]) => this.chunks.get(b)!.newestS - this.chunks.get(a)!.newestS || (a < b ? 1 : -1));
    for (const [, chunk] of byAge.slice(0, 2)) for (const row of chunk.r) if (row[0] === 'r') this.remember(row[17]);
    const [newest] = byAge;
    if (newest && jsonBytes(newest[1]) < CHUNK_TARGET_CHARS) {
      this.open = { key: newest[0], rows: newest[1].r, verified: false };
      for (const row of newest[1].r) if (row[0] === 'r') this.mutable.set(row[17], row);
    }
    this.first = this.chunks.size === 0;
  }
  /** Keeps pending rows, cursors and the open chunk; refreshes sizes after another frame wrote. */
  private recount(entries: Entries): void {
    this.book.recompute(entries);
    const present = new Set(entries.map(([key]) => key));
    for (const key of [...this.chunks.keys()]) if (!present.has(key)) this.chunks.delete(key);
    for (const [key, value] of entries) {
      const rows = isChunkKey(key) && !this.chunks.has(key) ? parseChunk(value)?.r : undefined;
      if (rows?.length) this.chunks.set(key, infoOf(key, rows));
    }
    if (this.open && !present.has(this.open.key)) this.open = null;
    this.stale = false;
  }
  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > RECENT_IDS) this.seen.delete(this.seen.values().next().value!);
  }
  private relabel(id: string, attr: LedgerAttr): void {
    const row = this.mutable.get(id);
    if (!row || attr === 'not-observed' || row[13] === attr) return;
    row[13] = attr;
    this.relabeled = true;
  }
  private push(row: LedgerRow, connection: string | null, cursor: LedgerCursor | null): void {
    this.pending.push({ row, connection, cursor: cursor && [...cursor] });
    if (row[0] === 'r') this.mutable.set(row[17], row);
  }
  /** Cursors acknowledged once the first `count` pending rows are stored: all consumed cursors when none stay behind. */
  private cursorsAfter(count: number): Map<string, LedgerCursor> {
    if (count === this.pending.length) return bounded(new Map([...this.persisted, ...this.cursors]));
    const result = new Map(this.persisted);
    for (const { connection, cursor } of this.pending.slice(0, count)) if (connection && cursor) result.set(connection, cursor);
    return bounded(result);
  }
  private applyClear(clearedAt: number): void {
    this.clearedAt = clearedAt;
    const names = this.modelList;
    this.pending = this.pending.filter(entry => rowTimeS(entry.row) * 1000 >= clearedAt);
    this.chunks.clear(); this.open = null; this.mutable.clear(); this.relabeled = false; this.stored = null; this.baselineAt = -Infinity;
    this.modelList = []; this.modelIndex.clear(); this.modelsDirty = false;
    // Rows recorded after the clear keep their model: re-number them against the fresh dictionary.
    for (const { row } of this.pending) {
      if (row[0] === 'g') continue;
      const index = row[0] === 'r' ? 3 : 4, ref = row[index] as number | null;
      (row as unknown[])[index] = ref === null ? null : this.modelRef(names[ref] ?? null);
      if (row[0] === 'r') this.mutable.set(row[17], row);
    }
    this.first = true;
  }
  private usageOf(book: Accounting, chunks: Iterable<ChunkInfo>): LedgerUsage {
    const view = book.view(), list = [...chunks];
    const pendingReplies = this.stateValue === 'stopped' ? 0 : this.pending.filter(entry => entry.row[0] === 'r').length;
    const oldestS = list.length ? Math.min(...list.map(chunk => chunk.oldestS)) : null;
    const newestS = list.length ? Math.max(...list.map(chunk => chunk.newestS)) : null;
    return { ledgerBytes: view.ledgerBytes, capBytes: view.capBytes, namespaceBytes: view.totalBytes, keys: view.keys,
      replies: list.reduce((sum, chunk) => sum + chunk.replies, 0) + pendingReplies,
      days: oldestS === null || newestS === null ? 0 : Math.max(1, Math.ceil((newestS - oldestS) / dayS)),
      retentionDays: this.retention, paused: this.paused, oldestS };
  }

  private async write(reason: FlushReason): Promise<void> {
    const epoch = this.epoch, storage = this.options.storage, now = this.options.now();
    if (reason === 'hidden') this.lastHideFlushAt = now;
    let relabeled = false;
    try {
      await this.refresh();
      if (this.stale) this.recount(await this.entries());
      if (this.open && !this.open.verified) await this.verifyOpen();
      if (epoch !== this.epoch || !this.pending.length && !this.relabeled) return;
      const expiryS = toSeconds(now) - this.retention * dayS;
      // The open chunk is rewritten whole; its expired rows are dropped on the way.
      const base = (this.open?.rows ?? []).filter(row => rowTimeS(row) >= expiryS);
      let take = this.pending.length, key = this.open?.key ?? null, rows = [...base, ...this.pending.map(entry => entry.row)];
      // A chunk spans at most a day, so retention deletes whole chunks within a day of their rows expiring.
      const spent = base.length > 0 && Math.min(...base.map(row => row[1])) < toSeconds(now) - CHUNK_SPAN_S;
      if (spent || jsonBytes(chunkValue(rows, this.cursorsAfter(take))) > CHUNK_TARGET_CHARS) {
        // Full or a day old: this flush starts a new chunk with as many pending rows as fit; the rest wait for the next flush.
        key = null;
        let low = 1, high = this.pending.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (jsonBytes(chunkValue(this.pending.slice(0, middle).map(entry => entry.row), this.cursorsAfter(middle))) <= CHUNK_TARGET_CHARS) low = middle;
          else high = middle - 1;
        }
        take = low;
        rows = this.pending.slice(0, take).map(entry => entry.row);
      }
      if (!rows.length) { this.relabeled = false; return; }
      const acked = this.cursorsAfter(take), value = JSON.parse(JSON.stringify(chunkValue(rows, acked))) as ChunkV2;
      if (jsonBytes(value) >= CHUNK_MAX_CHARS) throw new RangeError('ledger chunk over its limit');
      key ??= this.newKey(Math.min(...rows.map(row => row[1])));
      const models = this.modelsDirty ? [...this.modelList] : null;
      const delta = entryBytes(key, value) - this.book.size(key) + (models ? entryBytes(KEYS.models, models) - this.book.size(KEYS.models) : 0);
      const keys = (this.book.has(key) ? 0 : 1) + (models && !this.book.has(KEYS.models) ? 1 : 0);
      if (!this.book.hostFits(delta, keys)) {
        // Accounting, not an error: other keys took the headroom. Room comes from the oldest chunks, never the open one.
        await this.evict(toSeconds(now), delta, keys);
        if (!this.book.hostFits(delta, keys)) { this.retryAt = now + BACKOFF_MS.first; return; }
      }
      // The dictionary goes first, so a stored row never names a model the stored dictionary lacks.
      if (models) {
        await storage.set(KEYS.models, models);
        this.book.apply(KEYS.models, undefined, models);
        if (this.modelList.length === models.length) this.modelsDirty = false;
      }
      // Labels that change while the set is in flight belong to the next flush.
      relabeled = this.relabeled; this.relabeled = false;
      await storage.set(key, value as unknown as JsonValue);
      relabeled = false;
      if (epoch !== this.epoch) return;
      this.book.apply(key, undefined, value);
      this.chunks.set(key, infoOf(key, rows));
      this.persisted = acked;
      if (key !== this.open?.key) for (const row of this.open?.rows ?? []) if (row[0] === 'r') this.mutable.delete(row[17]);
      this.open = { key, rows, verified: true };
      this.pending = this.pending.slice(take);
      this.lastFlushAt = now; this.failures = 0; this.retryAt = 0; this.first = false;
      this.stateValue = this.paused ? 'paused' : 'idle';
      await this.writeBaselines(now);
      await this.evict(toSeconds(now), CHUNK_TARGET_CHARS, 1);
    } catch {
      if (relabeled) this.relabeled = true;
      if (epoch === this.epoch) await this.rejected(now);
    }
  }
  /**
   * What other frames changed since start: Clear, retention and Pause, and keys they added or removed (captures,
   * preferences), so the headroom is kept against the namespace as it is now. One `keys` and two reads per flush,
   * plus one read per new key.
   */
  private async refresh(): Promise<void> {
    const storage = this.options.storage;
    const [keys, meta, pref] = await Promise.all([storage.keys(), storage.get(KEYS.meta), storage.get(KEYS.pref)]);
    const clearedAt = parseMeta(meta)?.clearedAt ?? 0, settings = parsePref(pref);
    if (clearedAt > this.clearedAt) this.applyClear(clearedAt);
    if (JSON.stringify(settings) !== this.prefSeen) {
      this.prefSeen = JSON.stringify(settings);
      this.retention = retentionDays(this.options.retentionDays) ?? settings.retentionDays;
      this.setPausedLocal(!settings.history);
    }
    const present = new Set(keys);
    for (const key of this.book.keyList()) {
      if (present.has(key)) continue;
      this.book.apply(key, undefined, undefined); this.chunks.delete(key);
      if (this.open?.key === key) this.open = null;
    }
    this.book.apply(KEYS.meta, undefined, meta); this.book.apply(KEYS.pref, undefined, pref);
    for (const key of keys.filter(key => !this.book.has(key))) {
      const value = await storage.get(key);
      this.book.apply(key, undefined, value);
      const rows = isChunkKey(key) ? parseChunk(value)?.r : undefined;
      if (rows?.length) this.chunks.set(key, infoOf(key, rows));
    }
  }
  private setPausedLocal(paused: boolean): void {
    this.paused = paused;
    if (this.stateValue === 'idle' || this.stateValue === 'paused') this.stateValue = paused ? 'paused' : 'idle';
  }
  /** An adopted chunk is re-read once and merged, so an old leader's last write is never overwritten. */
  private async verifyOpen(): Promise<void> {
    const open = this.open!, stored = parseChunk(await this.options.storage.get(open.key));
    if (!stored) { this.open = null; return; }
    const merged = new Map(stored.r.map(row => [rowIdentity(row), row] as const));
    for (const row of open.rows) if (!merged.has(rowIdentity(row))) merged.set(rowIdentity(row), row);
    // Rows the old leader stored after this one started are also pending here (re-read from the ring): keep one, ours.
    this.pending = this.pending.filter(({ row }) => !merged.has(rowIdentity(row)) || !merged.set(rowIdentity(row), row));
    open.rows = [...merged.values()].sort((a, b) => rowTimeS(a) - rowTimeS(b));
    for (const row of open.rows) if (row[0] === 'r') { this.mutable.set(row[17], row); this.remember(row[17]); }
    open.verified = true;
  }
  private newKey(startS: number): string {
    let key = chunkKey(startS, this.options.random?.() ?? rand4());
    while (this.book.has(key) || this.chunks.has(key)) key = chunkKey(startS, rand4());
    return key;
  }
  /** After a flush only: chunks past retention, then the oldest until the next chunk fits under the cap with headroom. */
  private async evict(nowS: number, reserve: number, keys: number): Promise<void> {
    const expiryS = nowS - this.retention * dayS;
    const order = [...this.chunks.values()].filter(chunk => chunk.key !== this.open?.key)
      .sort((a, b) => a.newestS - b.newestS || (a.key < b.key ? -1 : 1));
    for (const chunk of order) {
      if (chunk.newestS >= expiryS && this.book.fits(reserve, keys)) break;
      await this.options.storage.delete(chunk.key);
      this.book.apply(chunk.key, undefined, undefined);
      this.chunks.delete(chunk.key);
    }
  }
  /** At most every 10 min, only after a successful flush and only when they changed: never an idle write. */
  private async writeBaselines(now: number): Promise<void> {
    if (now - this.baselineAt < BASELINE_WRITE_MS) return;
    const baselines = await this.computeBaselines(now);
    this.baselineAt = now;
    if (this.stored && sameBaselines(baselines, this.stored) || !this.stored && !baselines.size) return;
    const value = toBaselineStore(baselines, now);
    if (!this.book.fits(entryBytes(KEYS.baseline, value) - this.book.size(KEYS.baseline))) return;
    await this.options.storage.set(KEYS.baseline, value as unknown as JsonValue);
    this.book.apply(KEYS.baseline, undefined, value);
    this.stored = baselines;
  }
  /** HOST_REJECTED looks the same for "full", "not approved" and "disabled": a read tells them apart. Never evicts. */
  private async rejected(now: number): Promise<void> {
    try { await this.options.storage.get(KEYS.meta); } catch {
      this.pending = []; this.stateValue = 'stopped';
      return;
    }
    this.failures += 1; this.stale = true;
    this.retryAt = now + Math.min(BACKOFF_MS.max, BACKOFF_MS.first * 2 ** (this.failures - 1));
    this.stateValue = 'backoff';
  }
}

/**
 * The leader-only wiring in one place: start on election, stop on losing the lease (the service ring keeps what was not
 * flushed, and the next leader reads it from the persisted cursor), append each poll, flush when due.
 */
export class LedgerRecorder {
  private leading = false;
  private starting: Promise<void> | null = null;
  constructor(readonly ledger: Ledger, private readonly label: (completion: CompletionV2) => LedgerAttr = verdictAttr) {}
  get recording(): boolean { return this.leading && this.ledger.state !== 'stopped'; }
  /** The `since` the next poll must send while this frame leads; undefined otherwise. */
  since(connection: string, now?: number): number | undefined { return this.leading ? this.ledger.since(connection, now) : undefined; }
  async observe(snapshot: SnapshotV2, now: number, sentSince?: number): Promise<void> {
    if (!snapshot.lease.leader) {
      if (this.leading) { this.leading = false; this.starting = null; this.ledger.dispose(); }
      return;
    }
    if (!this.leading) { this.leading = true; this.starting = this.ledger.start(); }
    await this.starting;
    const runtime = snapshot.connection.runtime;
    if (!this.leading || !runtime) return;
    this.ledger.append(snapshot.completions, this.label, { connection: snapshot.connection.id, rt: runtime, since: sentSince });
    const reason = this.ledger.due('rows', now) ? 'rows' : this.ledger.due('timer', now) ? 'timer' : null;
    if (reason) await this.ledger.flush(reason);
  }
  /** visibility hidden or pagehide. */
  async hidden(now: number): Promise<void> {
    if (this.leading && this.ledger.due('hidden', now)) await this.ledger.flush('hidden');
  }
  dispose(): void { this.leading = false; this.starting = null; this.ledger.dispose(); }
}
