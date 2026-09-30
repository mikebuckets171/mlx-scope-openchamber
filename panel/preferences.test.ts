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

test('pref.v2 is read once, written only on a set, keeps keys other frames or tracks wrote, and never blocks on a failure', async () => {
  const { PrefsV2 } = await import('./preferences.ts');
  const store = new Map<string, unknown>([['pref.v2', { retentionDays: 30, toasts: 'all' }]]), writes: unknown[] = [];
  const prefs = new PrefsV2({ get: async key => store.get(key), set: async (key, value) => { writes.push(value); store.set(key, value); } });
  expect(await prefs.load()).toMatchObject({ toasts: 'all', tipDismissed: undefined });
  expect(writes).toEqual([]);
  store.set('pref.v2', { retentionDays: 30, toasts: 'all', recordingPaused: true });
  await prefs.set({ tipDismissed: true });
  expect(store.get('pref.v2')).toEqual({ retentionDays: 30, toasts: 'all', recordingPaused: true, tipDismissed: true });
  expect(prefs.value).toMatchObject({ tipDismissed: true, toasts: 'all' });
  const broken = new PrefsV2({ get: async () => { throw Error('HOST_REJECTED'); }, set: async () => { throw Error('HOST_REJECTED'); } });
  expect(await broken.load()).toMatchObject({ statusExpanded: undefined });
  await broken.set({ statusExpanded: true }).catch(() => {});
  expect(broken.value.statusExpanded).toBe(true);
});
