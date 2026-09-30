import { expect, test } from 'bun:test';
import { createFakeStorage } from '../testing/storage.ts';
import { DEFAULT_PREF, KEYS } from './ledger-schema.ts';
import { PrefStore } from './prefs.ts';

test('pref.v2: defaults without a value, one write per real change, merged across frames', async () => {
  const storage = createFakeStorage();
  const a = new PrefStore(storage), b = new PrefStore(storage);
  expect(await a.load()).toEqual(DEFAULT_PREF);
  await a.update({ toasts: 'critical', history: true });
  expect(storage.stats().sets).toBe(0);
  // Each write re-reads the stored value, so one frame's choice survives another's (S5: truly simultaneous writes can still lose one).
  await a.update({ tipDismissed: true });
  await b.update({ retentionDays: 90 });
  expect(storage.dump()[KEYS.pref]).toEqual({ ...DEFAULT_PREF, tipDismissed: true, retentionDays: 90 });
  expect(storage.stats().sets).toBe(2);
  await b.update({ retentionDays: 500 });
  expect(b.value.retentionDays).toBe(90);
  expect(storage.stats().sets).toBe(2);
});

test('an unreadable store keeps the defaults and never throws on load', async () => {
  const store = new PrefStore(createFakeStorage({ reject: () => true }));
  expect(await store.load()).toEqual(DEFAULT_PREF);
  await expect(store.update({ autoLabel: false })).rejects.toThrow();
  expect(store.value.autoLabel).toBe(true);
});
