import { expect, test } from 'bun:test';
import type { CompletionV2 } from '../../src/contract/completion.ts';
import {
  chunkKey, chunkStartS, cofactorBits, COFACTOR, DEFAULT_PREF, ledgerAttr, parseChunk, parseMeta, parsePref, parseRow, replyRow,
  sizeBucket, turnRowOf, verdictAttr, type ReplyRow, type TurnRow,
} from './ledger-schema.ts';

const AT = 1_790_690_700_000;
const completion = (extra: Partial<CompletionV2> = {}): CompletionV2 => ({ seq: 58, finishedAt: AT + 999, startedAt: AT - 30_000, model: 'Example-27B-4bit',
  basis: 'reported', promptTokens: 12_000, cachedTokens: 8_000, outputTokens: 1_204, ttftMs: 520.4, decodeTps: 38.14, prefillTps: 598.26,
  overlapped: false, host: { pressureMax: 2, swapDeltaBytes: 128 * 1024 ** 2, thermalMaxLevel: 1, energyJ: 41.26, powerCoverage: 0.9 }, ...extra });

test('a completion becomes one positional reply row with ×10 rates, size buckets, co-factor bits and the (instance, seq) id', () => {
  const row = replyRow(completion(), '5c1e0a7b', 'lmstudio', 3, 'inferred');
  expect(row).toEqual(['r', 1_790_690_700, 'lmstudio', 3, 1, 0, 12_000, 8_000, 1_204, 520, 5_983, 381, 'reported', 'inferred', null,
    COFACTOR.pressure | COFACTOR.swap, 413, '5c1e0a7b.58']);
  expect(parseRow(JSON.parse(JSON.stringify(row)))).toEqual(row);
  // Nothing class A and no model name in a row: the model is a dictionary ref.
  expect(JSON.stringify(row)).not.toContain('Example');
  const sparse = replyRow(completion({ promptTokens: undefined, cachedTokens: undefined, outputTokens: undefined, ttftMs: undefined,
    decodeTps: undefined, prefillTps: undefined, basis: 'last-observed', overlapped: true, aggregateOf: 3, host: {} }), '5c1e0a7b', 'omlx', null, 'not-observed');
  expect(sparse).toEqual(['r', 1_790_690_700, 'omlx', null, null, null, null, null, null, null, null, null, 'last-observed', 'not-observed', null,
    COFACTOR.overlapped | COFACTOR.aggregate, null, '5c1e0a7b.58']);
  expect(parseRow(sparse)).toEqual(sparse);
});

test('uncached bucket needs both counts; context is prompt + output', () => {
  expect(replyRow(completion({ cachedTokens: undefined }), '5c1e0a7b', 'omlx', 0, 'armed')[5]).toBeNull();
  expect(replyRow(completion({ promptTokens: 40_000, outputTokens: 30_000, cachedTokens: 0 }), '5c1e0a7b', 'omlx', 0, 'armed').slice(4, 6)).toEqual([3, 2]);
  expect([0, 8_191, 8_192, 32_767, 32_768, 65_536, 131_071, 131_072, null].map(sizeBucket)).toEqual([0, 0, 1, 1, 2, 3, 3, 4, null]);
});

test('parseRow rejects anything malformed instead of coercing it', () => {
  const good = replyRow(completion(), '5c1e0a7b', 'splash', 0, 'withheld:overlap');
  expect(parseRow(good)).toEqual(good);
  const broken: unknown[][] = [
    [...good.slice(0, 17)], [...good, 'extra'], Object.assign([...good], { 2: 'vllm' }), Object.assign([...good], { 1: -1 }),
    Object.assign([...good], { 13: 'withheld:secret' }), Object.assign([...good], { 13: 'This chat' }), Object.assign([...good], { 12: 'guess' }),
    Object.assign([...good], { 17: 'session-id' }), Object.assign([...good], { 17: '5c1e0a7b.0' }), Object.assign([...good], { 4: 5 }),
    Object.assign([...good], { 6: 1.5 }), Object.assign([...good], { 15: 32 }), Object.assign([...good], { 1: null }), Object.assign([...good], { 9: Number.NaN }),
  ];
  for (const row of broken) expect(parseRow(row)).toBeNull();
  const turn: TurnRow = ['t', 100, 160, 'lmstudio', 0, 3, 3_104, 520, 381, 37_000, 'inferred', 0];
  expect(parseRow(turn)).toEqual(turn);
  expect(parseRow(['t', 170, 160, 'lmstudio', 0, 3, 3_104, 520, 381, 37_000, 'inferred', 0])).toBeNull();
  expect(parseRow(['g', 100, 200])).toEqual(['g', 100, 200]);
  expect(parseRow(['g', 200, 100])).toBeNull();
  for (const value of [null, {}, 'r', ['x', 1], ['g', 1]]) expect(parseRow(value)).toBeNull();
});

test('labels: verdicts map to ledger attrs, unknown reasons are refused', () => {
  expect(verdictAttr({})).toBe('not-observed');
  expect(verdictAttr({ verdict: { attr: 'inferred', at: AT } })).toBe('inferred');
  expect(verdictAttr({ verdict: { attr: 'armed', at: AT } })).toBe('armed');
  expect(verdictAttr({ verdict: { attr: 'withheld', reason: 'outside-turn', at: AT } })).toBe('withheld:outside-turn');
  expect(verdictAttr({ verdict: { attr: 'withheld', at: AT } })).toBe('not-observed');
  expect(ledgerAttr('withheld:joined-mid-turn')).toBe('withheld:joined-mid-turn');
  expect(ledgerAttr('withheld:')).toBeNull();
});

test('co-factor bits: pressure ≥ warning, swap ≥ 64 MiB, thermal ≥ heavy, overlap, aggregation', () => {
  const base = { overlapped: false, host: {} };
  expect(cofactorBits(base)).toBe(0);
  expect(cofactorBits({ ...base, host: { pressureMax: 1, swapDeltaBytes: 64 * 1024 ** 2 - 1, thermalMaxLevel: 1 } })).toBe(0);
  expect(cofactorBits({ ...base, host: { pressureMax: 4, swapDeltaBytes: 64 * 1024 ** 2, thermalMaxLevel: 2 } })).toBe(7);
  expect(cofactorBits({ overlapped: true, aggregateOf: 2, host: {} })).toBe(24);
});

test('turn rows keep only host co-factors and whole seconds', () => {
  expect(turnRowOf({ startedAt: AT, endedAt: AT + 112_400, rt: 'lmstudio', modelRef: 2, steps: 3, outputTokens: 3_104, firstTtftMs: 520.4,
    decodeTps: 38.14, waitMs: 37_000, attr: 'inferred', cofactors: 31 })).toEqual(['t', 1_790_690_700, 1_790_690_812, 'lmstudio', 2, 3, 3_104, 520, 381, 37_000, 'inferred', 7]);
});

test('chunk keys: base-36 start second and four random hex digits', () => {
  const key = chunkKey(1_790_690_700.9, 'a1b2');
  expect(key).toBe(`ledger.v2.c.${(1_790_690_700).toString(36)}.a1b2`);
  expect(chunkStartS(key)).toBe(1_790_690_700);
  expect(chunkStartS('ledger.v2.c.zz.nothex')).toBeNull();
  expect(key.length).toBeLessThan(128);
});

test('chunks, meta and pref parse defensively', () => {
  const row: ReplyRow = replyRow(completion(), '5c1e0a7b', 'lmstudio', 0, 'inferred');
  const chunk = parseChunk({ v: 2, c: { lmstudio: ['5c1e0a7b', 58, 1_790_690_700], 'bad id!': ['5c1e0a7b', 1, 1], x: ['nothex', 1, 1] }, r: [row, ['bad'], null] });
  expect(chunk).toEqual({ v: 2, c: { lmstudio: ['5c1e0a7b', 58, 1_790_690_700] }, r: [row] });
  expect(parseChunk({ v: 1, r: [] })).toBeNull();
  expect(parseMeta({ schema: 2, migratedAt: AT, accounting: { bytes: 10, keys: 2 }, clearedAt: AT + 1 })).toEqual({ schema: 2, migratedAt: AT, accounting: { bytes: 10, keys: 2 }, clearedAt: AT + 1 });
  expect(parseMeta({ schema: 1 })).toBeNull();
  expect(parsePref(undefined)).toEqual(DEFAULT_PREF);
  expect(parsePref({ history: false, retentionDays: 365, toasts: 'loud', autoLabel: 'no', tipDismissed: true })).toEqual({ ...DEFAULT_PREF, history: false, retentionDays: 90, tipDismissed: true });
  expect(parsePref({ retentionDays: 0 }).retentionDays).toBe(1);
});
