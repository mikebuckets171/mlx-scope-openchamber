import { expect, test } from 'bun:test';
import { Preferences } from './preferences.ts';

test('preferences read once per key, accept only booleans and fail without blocking', async () => {
  const gets: string[] = [], values: unknown[] = [];
  const preferences = new Preferences({ get: async key => { gets.push(key); return key === 'view.compact' ? true : 'true'; }, set: async () => {} });
  await preferences.load((key, value) => values.push([key, value]));
  expect(gets).toHaveLength(2); expect(values).toEqual([['compact', true]]);
  const failing = new Preferences({ get: async () => { throw Error('unavailable'); }, set: async () => {} });
  await failing.load(() => { throw Error('Must not apply'); });
});
test('slow preference loads cannot undo a newer click', async () => {
  const resolvers: Array<(value: unknown) => void> = [], applied: unknown[] = [];
  const preferences = new Preferences({ get: () => new Promise(resolve => resolvers.push(resolve)), set: async () => {} });
  const pending = preferences.load((key, value) => applied.push([key, value]));
  await preferences.set('compact', true);
  resolvers.forEach(resolve => resolve(false)); await pending;
  expect(applied).toEqual([['efficient', false]]);
});
test('rapid writes keep click order, recover after failure, and touch no other key', async () => {
  const calls: unknown[] = [];
  const preferences = new Preferences({ get: async () => null, set: async (key, value) => { calls.push([key, value]); if (calls.length === 1) throw Error('failed'); } });
  const first = preferences.set('efficient', true).catch(() => {});
  const last = preferences.set('efficient', false);
  await Promise.all([first, last]);
  expect(calls).toEqual([['view.efficient', true], ['view.efficient', false]]);
});

test('pref.v2 is the ledger schema: read once, written only on a change, applied at once, and never blocks on a failure', async () => {
  const { PrefsV2 } = await import('./preferences.ts');
  const store = new Map<string, unknown>([['pref.v2', { retentionDays: 45, toasts: 'all' }]]), writes: unknown[] = [];
  const storage = { get: async (key: string) => store.get(key) as never, set: async (key: string, value: unknown) => { writes.push(value); store.set(key, value); },
    delete: async () => {}, keys: async () => [...store.keys()] };
  const prefs = new PrefsV2(storage);
  expect(await prefs.load()).toMatchObject({ toasts: 'all', retentionDays: 45, tipDismissed: false, firstRunDismissed: false, statusExpanded: false });
  expect(writes).toEqual([]);
  // Another frame paused recording meanwhile: the write merges with what is stored now.
  store.set('pref.v2', { retentionDays: 45, toasts: 'all', history: false });
  await prefs.set({ tipDismissed: true, firstRunDismissed: true });
  expect(store.get('pref.v2')).toMatchObject({ retentionDays: 45, toasts: 'all', history: false, tipDismissed: true, noticeDismissed: true });
  expect(prefs.value).toMatchObject({ tipDismissed: true, firstRunDismissed: true, toasts: 'all', history: false });
  await prefs.set({ tipDismissed: true });
  expect(writes).toHaveLength(1);
  const broken = new PrefsV2({ ...storage, get: async () => { throw Error('HOST_REJECTED'); }, set: async () => { throw Error('HOST_REJECTED'); } });
  expect(await broken.load()).toMatchObject({ statusExpanded: false });
  await broken.set({ statusExpanded: true }).catch(() => {});
  expect(broken.value.statusExpanded).toBe(true);
});
