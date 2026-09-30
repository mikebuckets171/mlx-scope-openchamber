import { expect, test } from 'bun:test';
import { createFakeStorage } from '../testing/storage.ts';
import { Accounting, entryBytes, HEADROOM_BYTES, LEDGER_CAP_BYTES, STORAGE_LIMITS } from './accounting.ts';

const entries = async (storage: ReturnType<typeof createFakeStorage>) =>
  Promise.all((await storage.keys()).map(async key => [key, await storage.get(key)] as const));

test('accounting equals the serialized namespace file byte for byte, through sets, overwrites and deletes', async () => {
  const storage = createFakeStorage(), book = new Accounting();
  expect(book.recompute([]).totalBytes).toBe(storage.stats().fileBytes);
  const writes: Array<[string, unknown]> = [['view.compact', true], ['pref.v2', { v: 2, history: true }], ['ledger.v2.models', ['Modèle-ü', 'Example']],
    ['ledger.v2.c.abc.0001', { v: 2, c: {}, r: [['g', 100, 200]] }], ['capture.v2.x.0001', { v: 2, measurements: { decodeTps: 25.1 } }],
    ['pref.v2', { v: 2, history: false, retentionDays: 90 }], ['emoji', '☕'.repeat(10)]];
  for (const [key, value] of writes) {
    const before = await storage.get(key);
    await storage.set(key, value as never);
    expect(book.apply(key, before, value).totalBytes).toBe(storage.stats().fileBytes);
  }
  for (const key of ['view.compact', 'ledger.v2.c.abc.0001', 'never-there']) {
    await storage.delete(key);
    expect(book.apply(key, undefined, undefined).totalBytes).toBe(storage.stats().fileBytes);
  }
  const fresh = new Accounting().recompute(await entries(storage));
  expect(fresh).toEqual(book.view());
  expect(fresh.keys).toBe(storage.stats().entries);
  expect(fresh.ledgerBytes).toBe(entryBytes('ledger.v2.models', ['Modèle-ü', 'Example']));
});

test('oldest row time comes from the chunks only', () => {
  const book = new Accounting();
  const view = book.recompute([['ledger.v2.c.a.0001', { v: 2, c: {}, r: [['g', 500, 600], ['t', 400, 450, 'omlx', 0, 1, 10, null, null, null, 'inferred', 0]] }],
    ['ledger.v2.c.b.0001', { v: 2, c: {}, r: [['g', 700, 800]] }], ['capture.v2.q', { savedAt: 1 }]]);
  expect(view.oldestS).toBe(400);
  expect(book.apply('ledger.v2.c.a.0001', null, undefined).oldestS).toBe(700);
});

test('fits keeps the ledger under its cap and 128 KiB of the 2 MiB namespace free; hostFits is the hard limit', () => {
  const book = new Accounting();
  book.recompute([['ledger.v2.c.a.0001', 'x'.repeat(LEDGER_CAP_BYTES - 100)]]);
  expect(book.fits(50)).toBe(true);
  expect(book.fits(200)).toBe(false);
  book.recompute([['capture.v2.big', 'y'.repeat(STORAGE_LIMITS.totalBytes - HEADROOM_BYTES - 1_000)]]);
  expect(book.fits(900)).toBe(true);
  expect(book.fits(2_000)).toBe(false);
  expect(book.hostFits(2_000)).toBe(true);
  expect(book.hostFits(HEADROOM_BYTES + 1_000)).toBe(false);
  book.recompute(Array.from({ length: STORAGE_LIMITS.keys - 64 }, (_, index) => [`k${index}`, 1] as const));
  expect(book.fits(0, 1)).toBe(false);
  expect(book.hostFits(0, 64)).toBe(true);
  expect(book.hostFits(0, 65)).toBe(false);
});
