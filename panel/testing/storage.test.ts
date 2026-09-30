import { expect, test } from 'bun:test';
import { HostRequestError } from '@openchamber/sdk';
import { createFakeStorage, GENERIC_REJECTION, HOST_LIMITS } from './storage.ts';

const code = async (work: Promise<unknown>) => { try { await work; return 'ok'; } catch (error) { return error instanceof HostRequestError ? `${error.code}: ${error.message}` : String(error); } };

test('the fake keeps one JSON file, re-serialized on every write, and hands out copies', async () => {
  const storage = createFakeStorage({ initial: { 'view.compact': true } });
  const value = { rows: [[1, 2]] };
  await storage.set('a', value);
  value.rows[0]![0] = 99;
  expect(await storage.get('a')).toEqual({ rows: [[1, 2]] });
  const read = await storage.get('a') as { rows: number[][] };
  read.rows[0]![0] = 7;
  expect(await storage.get('a')).toEqual({ rows: [[1, 2]] });
  expect(await storage.get('missing')).toBeUndefined();
  await storage.set('n', null);
  expect(await storage.get('n')).toBeNull();
  expect(await storage.keys()).toEqual(['a', 'n', 'view.compact']);
  const stats = storage.stats();
  expect(stats.fileBytes).toBe(new TextEncoder().encode(JSON.stringify(storage.dump())).length);
  expect(stats).toMatchObject({ sets: 2, gets: 5, keys: 1, entries: 3, setKeys: ['a', 'n'] });
});

test('host limits: 64 KiB per value (specific message), 2 MiB and 2,000 keys (generic), 1–128 character keys', async () => {
  const storage = createFakeStorage();
  const exact = 'x'.repeat(HOST_LIMITS.valueBytes - 2);   // the JSON string adds two quotes
  expect(await code(storage.set('exact', exact))).toBe('ok');
  expect(await code(storage.set('over', `${exact}x`))).toBe('HOST_REJECTED: Storage value exceeds 64 KiB.');
  expect(await code(storage.set('', 1))).toStartWith('HOST_REJECTED: Storage key must contain');
  expect(await code(storage.set('k'.repeat(129), 1))).toStartWith('HOST_REJECTED: Storage key must contain');
  expect(await code(storage.set('nan', Number.NaN))).toBe('HOST_REJECTED: Storage values must be JSON.');
  const full = createFakeStorage();
  let index = 0;
  while (await code(full.set(`big.${index}`, 'y'.repeat(60_000))) === 'ok') index += 1;
  expect(index).toBe(34);
  expect(await code(full.set('one-more', 'z'.repeat(60_000)))).toBe(`HOST_REJECTED: ${GENERIC_REJECTION}`);
  expect(full.stats().fileBytes).toBeLessThanOrEqual(HOST_LIMITS.totalBytes);
  const many = createFakeStorage({ limits: { keys: 3 } });
  for (const key of ['a', 'b', 'c']) await many.set(key, 1);
  expect(await code(many.set('d', 1))).toBe(`HOST_REJECTED: ${GENERIC_REJECTION}`);
  expect(await code(many.set('a', 2))).toBe('ok');
});

test('a failed operation preserves the stored data, and rejections are injectable per operation and key', async () => {
  let failing = false;
  const storage = createFakeStorage({ reject: (op, key) => failing && (op !== 'get' || key === 'meta.v2') });
  await storage.set('a', 1);
  failing = true;
  expect(await code(storage.set('a', 2))).toBe(`HOST_REJECTED: ${GENERIC_REJECTION}`);
  expect(await code(storage.get('meta.v2'))).toStartWith('HOST_REJECTED');
  expect(await storage.get('a')).toBe(1);
  failing = false;
  expect(storage.stats().sets).toBe(1);
});

test('operations serialize in call order, as the host does', async () => {
  const storage = createFakeStorage(), order: string[] = [];
  await Promise.all([storage.set('a', 1).then(() => order.push('set a')), storage.get('a').then(value => order.push(`get ${value}`)),
    storage.delete('a').then(() => order.push('delete')), storage.get('a').then(value => order.push(`get ${value}`))]);
  expect(order).toEqual(['set a', 'get 1', 'delete', 'get undefined']);
});
