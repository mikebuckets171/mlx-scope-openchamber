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
