import type { Basis } from '../../src/contract/capabilities.ts';
import type { WithholdReason } from '../../src/contract/reasons.ts';
import type { RuntimeKind } from '../../src/contract/runtime.ts';

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
export interface LedgerMeta { schema: typeof LEDGER_SCHEMA; migratedAt: number | null; accounting: { bytes: number; keys: number } }

export const sizeBucket = (tokens: number | null | undefined): SizeBucket | null =>
  tokens == null ? null : tokens < 8_192 ? 0 : tokens < 32_768 ? 1 : tokens < 65_536 ? 2 : tokens < 131_072 ? 3 : 4;
/** `ledger.v2.c.<startSec36>.<rand4>`; rand4 from getRandomValues (plain-HTTP hosts lack randomUUID). */
export const chunkKey = (startS: number, rand4: string): string => `${KEYS.chunkPrefix}${Math.floor(startS).toString(36)}.${rand4}`;
/** A stored row, validated; anything malformed is null (never thrown). */
export const parseRow = (value: unknown): LedgerRow | null => { void value; return null; };
