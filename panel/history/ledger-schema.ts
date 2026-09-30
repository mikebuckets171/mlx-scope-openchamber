import type { ToastPreference } from '../alerts/signals.ts';
import { basis, type Basis } from '../../src/contract/capabilities.ts';
import type { CompletionV2 } from '../../src/contract/completion.ts';
import { at, bool, connectionId, count, finite, HEX8, nonneg, obj, oneOf } from '../../src/contract/guards.ts';
import { WITHHOLD_REASONS, type WithholdReason } from '../../src/contract/reasons.ts';
import { runtimeKind, type RuntimeKind } from '../../src/contract/runtime.ts';

// Owner: ledger. Row tuples and keys (plan §5.6). No session tag is persisted; model names only as dictionary refs.

export const LEDGER_SCHEMA = 2;
export const KEYS = {
  meta: 'meta.v2', pref: 'pref.v2', models: 'ledger.v2.models', chunkPrefix: 'ledger.v2.c.', baseline: 'baseline.v2',
  capturePrefix: 'capture.v2.', legacyObservationPrefix: 'observation.v1.',
} as const;
export const CHUNK_TARGET_CHARS = 56 * 1024;
export const CHUNK_MAX_CHARS = 60 * 1024;

/** Context and uncached-prompt buckets: <8k, 8–32k, 32–64k, 64–128k, >128k. */
export type SizeBucket = 0 | 1 | 2 | 3 | 4;
/** The ledger label: attributed, armed, withheld with its reason, or no verdict ("Server-wide · not observed"). */
export type LedgerAttr = 'inferred' | 'armed' | `withheld:${WithholdReason}` | 'not-observed';
/** Co-factor bits: 1 pressure ≥ warning, 2 swap grew, 4 thermal ≥ heavy, 8 overlapped, 16 aggregate. */
export type CofactorBits = number;
export type N = number | null;

/** `r`: one reply. Rates ×10 as integers; `id` = `${instance}.${seq}` for (instance, seq) dedupe. */
export type ReplyRow = ['r', finishedS: number, rt: RuntimeKind, modelRef: number | null, ctxB: SizeBucket | null, uncB: SizeBucket | null,
  prompt: N, cached: N, output: N, ttftMs: N, prefillTps10: N, decodeTps10: N, basis: Basis, attr: LedgerAttr, turnRef: N,
  cofactors: CofactorBits, energyJ10: N, id: string];
/** `t`: one attributed turn. */
export type TurnRow = ['t', startedS: number, endedS: number, rt: RuntimeKind, modelRef: number | null, steps: number, output: number,
  firstTtftMs: N, wDecodeTps10: N, waitMs: N, attr: LedgerAttr, cofactors: CofactorBits];
/** `g`: the ring moved past the persisted cursor (restart or overflow); history between is not observed. */
export type GapRow = ['g', fromS: number, toS: number];
export type LedgerRow = ReplyRow | TurnRow | GapRow;
export interface LedgerMeta {
  schema: typeof LEDGER_SCHEMA; migratedAt: number | null; accounting: { bytes: number; keys: number };
  /** Set by Clear: completions that finished before it are never recorded again, whichever frame leads later. */
  clearedAt?: number;
}

export const sizeBucket = (tokens: number | null | undefined): SizeBucket | null =>
  tokens == null ? null : tokens < 8_192 ? 0 : tokens < 32_768 ? 1 : tokens < 65_536 ? 2 : tokens < 131_072 ? 3 : 4;
/** `ledger.v2.c.<startSec36>.<rand4>`; rand4 from getRandomValues (plain-HTTP hosts lack randomUUID). */
export const chunkKey = (startS: number, rand4: string): string => `${KEYS.chunkPrefix}${Math.floor(startS).toString(36)}.${rand4}`;
export const CHUNK_KEY = /^ledger\.v2\.c\.([0-9a-z]{1,9})\.([0-9a-f]{4})$/;
export const chunkStartS = (key: string): number | null => { const match = CHUNK_KEY.exec(key); return match ? parseInt(match[1]!, 36) : null; };
export const rand4 = (): string => Array.from(crypto.getRandomValues(new Uint8Array(2)), byte => byte.toString(16).padStart(2, '0')).join('');

export const COFACTOR = { pressure: 1, swap: 2, thermal: 4, overlapped: 8, aggregate: 16 } as const;
/** Host co-factors only; overlap and aggregation are exclusions, not something "observed during". */
export const HOST_COFACTORS = COFACTOR.pressure | COFACTOR.swap | COFACTOR.thermal;
/** Page-level swap churn is not "swap grew"; 64 MiB over one reply is. */
export const SWAP_GREW_BYTES = 64 * 1024 ** 2;
const MAX_SECONDS = 8.64e12;
const ID = /^[0-9a-f]{8}\.[1-9]\d{0,15}$/;

const seconds = (value: unknown): number | null => { const n = count(value); return n !== null && n <= MAX_SECONDS ? n : null; };
const bucket = oneOf([0, 1, 2, 3, 4] as const);
const cofactors = (value: unknown): number | null => { const n = count(value); return n !== null && n < 32 ? n : null; };
const reasonOf = oneOf(WITHHOLD_REASONS);
export const ledgerAttr = (value: unknown): LedgerAttr | null => {
  if (value === 'inferred' || value === 'armed' || value === 'not-observed') return value;
  return typeof value === 'string' && value.startsWith('withheld:') && reasonOf(value.slice(9)) ? value as LedgerAttr : null;
};
/** The verdict the service stored for a completion, as a ledger label; no verdict = "Server-wide · not observed". */
export const verdictAttr = (completion: Pick<CompletionV2, 'verdict'>): LedgerAttr => {
  const verdict = completion.verdict;
  if (!verdict) return 'not-observed';
  return verdict.attr === 'withheld' ? verdict.reason ? `withheld:${verdict.reason}` : 'not-observed' : verdict.attr;
};

type Field = [guard: (value: unknown) => unknown, nullable: boolean];
const id = (value: unknown): string | null => typeof value === 'string' && ID.test(value) ? value : null;
const REPLY: Field[] = [[seconds, false], [runtimeKind, false], [count, true], [bucket, true], [bucket, true], [count, true], [count, true],
  [count, true], [nonneg, true], [count, true], [count, true], [basis, false], [ledgerAttr, false], [count, true], [cofactors, false],
  [count, true], [id, false]];
const TURN: Field[] = [[seconds, false], [seconds, false], [runtimeKind, false], [count, true], [count, false], [count, false], [nonneg, true],
  [count, true], [nonneg, true], [ledgerAttr, false], [cofactors, false]];
/** Every field passes its guard, or is null where null is allowed; nothing is coerced. */
const tuple = (row: unknown[], fields: Field[]): unknown[] | null => {
  if (row.length !== fields.length + 1) return null;
  const values = fields.map(([guard, nullable], index) => { const raw = row[index + 1]; return raw === null && nullable ? null : guard(raw) ?? undefined; });
  return values.includes(undefined) ? null : [row[0], ...values];
};
/** A stored row, validated; anything malformed is null (never thrown). */
export const parseRow = (value: unknown): LedgerRow | null => {
  if (!Array.isArray(value)) return null;
  if (value[0] === 'r') return tuple(value, REPLY) as ReplyRow | null;
  if (value[0] === 't') { const row = tuple(value, TURN) as TurnRow | null; return row && row[1] <= row[2] ? row : null; }
  const fromS = seconds(value[1]), toS = seconds(value[2]);
  return value[0] === 'g' && value.length === 3 && fromS !== null && toS !== null && fromS <= toS ? ['g', fromS, toS] : null;
};
/** The time a row sorts and expires by: a reply's finish, a turn's end, a gap's end. */
export const rowTimeS = (row: LedgerRow): number => row[0] === 'r' ? row[1] : row[2];
export const rowIdentity = (row: LedgerRow): string => row[0] === 'r' ? row[17] : row[0] === 't' ? `t.${row[3]}.${row[1]}` : `g.${row[1]}.${row[2]}`;

/** Where the ledger stopped reading one connection's completion ring: `[instance, seq, finishedS]`. */
export type LedgerCursor = [instance: string, seq: number, atS: number];
export const MAX_CURSORS = 8;
/** One chunk value. `c` is the persisted cursor (the ack): the service ring holds everything after it. */
export interface ChunkV2 { v: typeof LEDGER_SCHEMA; c: Record<string, LedgerCursor>; r: LedgerRow[] }
const cursor = (value: unknown): LedgerCursor | null => {
  if (!Array.isArray(value) || value.length !== 3 || typeof value[0] !== 'string' || !HEX8.test(value[0])) return null;
  const seq = count(value[1]), atS = seconds(value[2]);
  return seq !== null && atS !== null ? [value[0], seq, atS] : null;
};
export const parseCursors = (value: unknown): Map<string, LedgerCursor> => {
  const result = new Map<string, LedgerCursor>();
  for (const [key, raw] of Object.entries(obj(value) ?? {})) {
    const id = connectionId(key), parsed = cursor(raw);
    if (id && parsed && result.size < MAX_CURSORS) result.set(id, parsed);
  }
  return result;
};
export const parseChunk = (value: unknown): ChunkV2 | null => {
  const item = obj(value);
  if (!item || item.v !== LEDGER_SCHEMA || !Array.isArray(item.r)) return null;
  const rows: LedgerRow[] = [];
  for (const raw of item.r) { const row = parseRow(raw); if (row) rows.push(row); }
  return { v: LEDGER_SCHEMA, c: Object.fromEntries(parseCursors(item.c)), r: rows };
};
export const parseModels = (value: unknown): string[] =>
  Array.isArray(value) ? value.slice(0, MAX_MODELS).map(name => typeof name === 'string' && name.length <= 256 ? name : '') : [];
export const MAX_MODELS = 256;

export const parseMeta = (value: unknown): LedgerMeta | null => {
  const item = obj(value), accounting = obj(item?.accounting);
  if (!item || item.schema !== LEDGER_SCHEMA) return null;
  const clearedAt = at(item.clearedAt);
  return { schema: LEDGER_SCHEMA, migratedAt: at(item.migratedAt),
    accounting: { bytes: count(accounting?.bytes) ?? 0, keys: count(accounting?.keys) ?? 0 }, ...clearedAt !== null ? { clearedAt } : {} };
};

const TOASTS: readonly ToastPreference[] = ['critical', 'all', 'off'];
/** `pref.v2`: one small value, written only on user choices. */
export interface PrefV2 {
  v: typeof LEDGER_SCHEMA;
  history: boolean;                          // false = "Pause recording"
  retentionDays: number;                     // 1…90, default 30
  toasts: ToastPreference;                   // alerts.toasts (plan §5.7)
  autoLabel: boolean;                        // "This chat · inferred" auto-labelling
  tipDismissed: boolean;                     // "Replace Turn stats…" one-time tip (decision 13)
  noticeDismissed: boolean;                  // "Recording reply history locally · Open Scope to manage"
}
export const RETENTION_LIMITS = { min: 1, default: 30, max: 90 } as const;
export const DEFAULT_PREF: Readonly<PrefV2> = Object.freeze({ v: LEDGER_SCHEMA, history: true, retentionDays: RETENTION_LIMITS.default,
  toasts: 'critical', autoLabel: true, tipDismissed: false, noticeDismissed: false });
export const retentionDays = (value: unknown): number | null => {
  const n = finite(value);
  return n === null ? null : Math.min(RETENTION_LIMITS.max, Math.max(RETENTION_LIMITS.min, Math.round(n)));
};
/** Field by field: a damaged or older value keeps every field it still has right. */
export const parsePref = (value: unknown): PrefV2 => {
  const item = obj(value) ?? {}, toasts = oneOf(TOASTS)(item.toasts);
  return { v: LEDGER_SCHEMA, history: bool(item.history) ?? DEFAULT_PREF.history, retentionDays: retentionDays(item.retentionDays) ?? DEFAULT_PREF.retentionDays,
    toasts: toasts ?? DEFAULT_PREF.toasts, autoLabel: bool(item.autoLabel) ?? DEFAULT_PREF.autoLabel,
    tipDismissed: bool(item.tipDismissed) ?? false, noticeDismissed: bool(item.noticeDismissed) ?? false };
};

const x10 = (value: number | undefined): N => value == null ? null : Math.min(Number.MAX_SAFE_INTEGER, Math.round(value * 10));
const whole = (value: number | undefined): N => value == null ? null : Math.min(Number.MAX_SAFE_INTEGER, Math.round(value));
export const toSeconds = (ms: number): number => Math.floor(ms / 1000);
export const cofactorBits = (completion: Pick<CompletionV2, 'host' | 'overlapped' | 'aggregateOf'>): CofactorBits => {
  const host = completion.host;
  return (host.pressureMax !== undefined && host.pressureMax >= 2 ? COFACTOR.pressure : 0)
    | ((host.swapDeltaBytes ?? 0) >= SWAP_GREW_BYTES ? COFACTOR.swap : 0)
    | (host.thermalMaxLevel !== undefined && host.thermalMaxLevel >= 2 ? COFACTOR.thermal : 0)
    | (completion.overlapped ? COFACTOR.overlapped : 0) | ((completion.aggregateOf ?? 1) > 1 ? COFACTOR.aggregate : 0);
};
/** A completion as a reply row. Context = prompt + output (contract §11.8); uncached only when both counts are reported. */
export const replyRow = (completion: CompletionV2, instance: string, rt: RuntimeKind, modelRef: number | null, attr: LedgerAttr): ReplyRow => {
  const { promptTokens: prompt, cachedTokens: cached, outputTokens: output } = completion;
  return ['r', toSeconds(completion.finishedAt), rt, modelRef, sizeBucket(prompt == null ? null : prompt + (output ?? 0)),
    sizeBucket(prompt != null && cached != null && cached <= prompt ? prompt - cached : null),
    prompt ?? null, cached ?? null, output ?? null, whole(completion.ttftMs), x10(completion.prefillTps), x10(completion.decodeTps),
    completion.basis, attr, null, cofactorBits(completion), x10(completion.host.energyJ), `${instance}.${completion.seq}`];
};
export interface TurnInput {
  startedAt: number; endedAt: number; rt: RuntimeKind; modelRef: number | null; steps: number; outputTokens: number;
  firstTtftMs: number | null; decodeTps: number | null; waitMs: number | null; attr: LedgerAttr; cofactors: CofactorBits;
}
export const turnRowOf = (turn: TurnInput): TurnRow => ['t', toSeconds(turn.startedAt), Math.max(toSeconds(turn.startedAt), toSeconds(turn.endedAt)),
  turn.rt, turn.modelRef, Math.max(0, Math.round(turn.steps)), Math.max(0, Math.round(turn.outputTokens)), whole(turn.firstTtftMs ?? undefined),
  x10(turn.decodeTps ?? undefined), whole(turn.waitMs ?? undefined), turn.attr, turn.cofactors & HOST_COFACTORS];
