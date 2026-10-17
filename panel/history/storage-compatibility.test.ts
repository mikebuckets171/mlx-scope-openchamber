import { expect, test } from 'bun:test';
import { createFakeStorage } from '../testing/storage.ts';
import { FakeRing, T0 } from '../testing/completions.ts';
import { Ledger } from './ledger.ts';
import { DEFAULT_PREF, KEYS, verdictAttr } from './ledger-schema.ts';
import { PrefStore } from './prefs.ts';

for (const [key, value] of [
  [KEYS.meta, { schema: 3, accounting: { bytes: 100, keys: 1 } }],
  [KEYS.pref, { v: 3, history: false }],
  [KEYS.models, { v: 3, names: ['future model'] }],
  [KEYS.baseline, { v: 3, entries: [] }],
  ['ledger.v2.c.1.aaaa', { v: 3, r: [], c: {} }],
] as const) test(`unknown format at ${key} stays intact across start, append, flush and clear`, async () => {
  const initial = { [key]: value }, storage = createFakeStorage({ initial }), ledger = new Ledger({ storage, now: () => T0 });
  await ledger.start();
  expect(ledger.state).toBe('stopped');
  expect(ledger.issue).toContain('different format');
  const ring = new FakeRing(); ring.add(T0);
  ledger.append(ring.response(), verdictAttr, { connection: 'fixture', rt: 'lmstudio' });
  await ledger.flush('hidden');
  await expect(ledger.clear()).rejects.toThrow('different format');
  expect(storage.dump()).toEqual(initial);
  expect(storage.stats().sets + storage.stats().deletes).toBe(0);
});

test('a newer writer invalidates recording before the next flush mutates storage', async () => {
  const storage = createFakeStorage(), ledger = new Ledger({ storage, now: () => T0 });
  await ledger.start();
  const ring = new FakeRing(); ring.add(T0);
  ledger.append(ring.response(), verdictAttr, { connection: 'fixture', rt: 'lmstudio' });
  await storage.set(KEYS.meta, { schema: 3, accounting: { bytes: 0, keys: 0 } });
  const before = storage.dump();
  await ledger.flush('hidden');
  expect(ledger.state).toBe('stopped');
  expect(ledger.issue).toContain('different format');
  expect(storage.dump()).toEqual(before);
});

test('preferences preserve additive fields and refuse another major without affecting defaults', async () => {
  const storage = createFakeStorage({ initial: { [KEYS.pref]: { ...DEFAULT_PREF, futureChoice: 'keep' } } });
  await new PrefStore(storage).update({ history: false });
  expect(storage.dump()[KEYS.pref]).toEqual({ ...DEFAULT_PREF, history: false, futureChoice: 'keep' });
  await storage.set(KEYS.pref, { v: 3, history: false, futureChoice: 'keep' });
  const store = new PrefStore(storage), before = storage.dump();
  expect(await store.load()).toEqual(DEFAULT_PREF);
  await expect(store.update({ history: true })).rejects.toThrow('different format');
  expect(storage.dump()).toEqual(before);
});

test('captures and 1.x saves from earlier versions are never written or deleted, and are still counted', async () => {
  const kept = { 'capture.v2.kept.aaaa': { v: 2, savedAt: T0 - 86_400_000, kind: 'window', measurements: { decodeTps: 24.6 } },
    'observation.v1.fixture': { savedAt: T0 - 2 * 86_400_000 } };
  const storage = createFakeStorage({ initial: kept }), ledger = new Ledger({ storage, now: () => T0 });
  await ledger.start();
  const ring = new FakeRing(); ring.add(T0);
  ledger.append(ring.response(), verdictAttr, { connection: 'fixture', rt: 'lmstudio' });
  await ledger.flush('hidden');
  expect(ledger.accounting()).toMatchObject({ keptItems: 2 });
  expect(ledger.accounting()!.keptBytes).toBeGreaterThan(0);
  await ledger.clear();
  const after = storage.dump();
  for (const [key, value] of Object.entries(kept)) expect(after[key]).toEqual(value);
  expect(Object.keys(after).some(key => key.startsWith('ledger.v2.c.'))).toBe(false);
});

test('a verified open chunk changed to another major is preserved before it can be overwritten', async () => {
  const storage = createFakeStorage(), ledger = new Ledger({ storage, now: () => T0 }), ring = new FakeRing();
  await ledger.start(); ring.add(T0);
  ledger.append(ring.response(), verdictAttr, { connection: 'fixture', rt: 'lmstudio' }); await ledger.flush('hidden');
  const key = Object.keys(storage.dump()).find(key => key.startsWith(KEYS.chunkPrefix))!;
  const future = { v: 3, r: ['future record'], c: {} };
  await storage.set(key, future); const before = storage.dump();
  ring.add(T0 + 1000); ledger.append(ring.response(), verdictAttr, { connection: 'fixture', rt: 'lmstudio' }); await ledger.flush('hidden');
  expect(ledger.state).toBe('stopped'); expect(ledger.issue).toContain('different format');
  expect(storage.dump()).toEqual(before);
});

test('a known baseline changed to another major cannot be overwritten by the next baseline refresh', async () => {
  let now = T0;
  const future = { v: 3, entries: ['future baseline'] }, storage = createFakeStorage({ initial: { [KEYS.baseline]: { v: 2, computedAt: now, entries: [] } } });
  const ledger = new Ledger({ storage, now: () => now }), ring = new FakeRing();
  await ledger.start(); ring.add(now - 3_600_000);
  ledger.append(ring.response(), verdictAttr, { connection: 'fixture', rt: 'lmstudio' }); await ledger.flush('hidden');
  await storage.set(KEYS.baseline, future); now += 31 * 60_000; ring.add(now);
  ledger.append(ring.response(), verdictAttr, { connection: 'fixture', rt: 'lmstudio' }); await ledger.flush('hidden');
  expect(ledger.state).toBe('stopped'); expect(ledger.issue).toContain('different format');
  expect(storage.dump()[KEYS.baseline]).toEqual(future);
});

test('a model dictionary changed to another major cannot be overwritten when a new model appears', async () => {
  const storage = createFakeStorage(), ledger = new Ledger({ storage, now: () => T0 }), ring = new FakeRing();
  await ledger.start(); ring.add(T0);
  ledger.append(ring.response(), verdictAttr, { connection: 'fixture', rt: 'lmstudio' }); await ledger.flush('hidden');
  await storage.set(KEYS.models, { v: 3, names: ['future model'] }); const before = storage.dump();
  ring.add(T0 + 1000, { model: 'Another model' });
  ledger.append(ring.response(), verdictAttr, { connection: 'fixture', rt: 'lmstudio' }); await ledger.flush('hidden');
  expect(ledger.state).toBe('stopped'); expect(storage.dump()).toEqual(before);
});

test('retention cannot delete a cached old chunk that changed to another major', async () => {
  let now = T0;
  const storage = createFakeStorage(), ledger = new Ledger({ storage, now: () => now }), ring = new FakeRing();
  await ledger.start(); ring.add(now);
  ledger.append(ring.response(), verdictAttr, { connection: 'fixture', rt: 'lmstudio' }); await ledger.flush('hidden');
  const old = Object.keys(storage.dump()).find(key => key.startsWith(KEYS.chunkPrefix))!;
  now += 2 * 86_400_000; ring.add(now);
  ledger.append(ring.response(), verdictAttr, { connection: 'fixture', rt: 'lmstudio' }); await ledger.flush('hidden');
  expect(Object.keys(storage.dump()).filter(key => key.startsWith(KEYS.chunkPrefix))).toHaveLength(2);
  const future = { v: 3, r: ['future record'], c: {} }; await storage.set(old, future);
  await ledger.setRetention(1); now += 1000; ring.add(now);
  ledger.append(ring.response(), verdictAttr, { connection: 'fixture', rt: 'lmstudio' }); await ledger.flush('hidden');
  expect(ledger.state).toBe('stopped'); expect(ledger.issue).toContain('different format');
  expect(storage.dump()[old]).toEqual(future);
});

test('Clear rechecks a key changed after its initial inventory before deleting it', async () => {
  const key = 'ledger.v2.c.1.aaaa', future = { v: 3, r: ['future record'], c: {} };
  const storage = createFakeStorage({ initial: { [key]: { v: 2, r: [], c: {} } } });
  let reads = 0;
  const ledger = new Ledger({ now: () => T0, storage: { ...storage, keys: async () => {
    if (++reads === 2) await storage.set(key, future);
    return storage.keys();
  } } });
  await expect(ledger.clear()).rejects.toThrow('different format');
  expect(storage.dump()[key]).toEqual(future); expect(storage.stats().deletes).toBe(0);
});
