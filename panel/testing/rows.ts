import type { Basis } from '../../src/contract/capabilities.ts';
import type { RuntimeKind } from '../../src/contract/runtime.ts';
import type { GapRow, LedgerAttr, ReplyRow, SizeBucket, TurnRow } from '../history/ledger-schema.ts';

// Test support only (ui-history): ledger row tuples with readable defaults. Rates are given in tok/s and stored ×10.
export interface ReplyFields {
  at: number; rt?: RuntimeKind; modelRef?: number | null; ctxB?: SizeBucket | null; uncB?: SizeBucket | null;
  prompt?: number | null; cached?: number | null; output?: number | null; ttftMs?: number | null; prefillTps?: number | null; decodeTps?: number | null;
  basis?: Basis; attr?: LedgerAttr; turnRef?: number | null; cofactors?: number; energyJ?: number | null; id?: string;
}
let serial = 0;
export const reply = (f: ReplyFields): ReplyRow => ['r', Math.floor(f.at / 1000), f.rt ?? 'omlx', f.modelRef === undefined ? 0 : f.modelRef, f.ctxB === undefined ? 2 : f.ctxB,
  f.uncB === undefined ? 0 : f.uncB, f.prompt ?? null, f.cached ?? null, f.output === undefined ? 1000 : f.output, f.ttftMs ?? null,
  f.prefillTps == null ? null : Math.round(f.prefillTps * 10), f.decodeTps == null ? null : Math.round(f.decodeTps * 10), f.basis ?? 'reported',
  f.attr ?? 'not-observed', f.turnRef ?? null, f.cofactors ?? 0, f.energyJ == null ? null : Math.round(f.energyJ * 10), f.id ?? `5c1e0a7b.${++serial}`];
export const turn = (startedAt: number, endedAt: number, fields: { rt?: RuntimeKind; modelRef?: number; steps?: number; output?: number;
  firstTtftMs?: number | null; wDecodeTps?: number | null; waitMs?: number | null; attr?: LedgerAttr } = {}): TurnRow =>
  ['t', Math.floor(startedAt / 1000), Math.floor(endedAt / 1000), fields.rt ?? 'omlx', fields.modelRef ?? 0, fields.steps ?? 1, fields.output ?? 1000,
    fields.firstTtftMs ?? null, fields.wDecodeTps == null ? null : Math.round(fields.wDecodeTps * 10), fields.waitMs ?? null, fields.attr ?? 'inferred', 0];
export const gap = (fromAt: number, toAt: number): GapRow => ['g', Math.floor(fromAt / 1000), Math.floor(toAt / 1000)];
