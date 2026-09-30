import { expect, test } from 'bun:test';
import type { UsageQuery } from '../../src/contract/query.ts';
import { parseUsageV2, type UsageV2 } from '../../src/contract/usage.ts';
import { USAGE_CACHE_ENTRIES, USAGE_CACHE_MS, USAGE_RETRY_MS, UsageCache } from './usage-cache.ts';

const T = 1_790_690_700_000;
const body = (range: UsageV2['range'], at: number, patch: Partial<UsageV2> = {}): UsageV2 => ({
  contractVersion: 2, serverNow: at, available: true, range, cachedAt: at, basis: 'reported', granularity: range === '7d' ? 'hour' : 'day',
  buckets: [{ at: at - 3_600_000, requests: 3, promptTokens: 9_000, outputTokens: 700 }], totals: { requests: 3, promptTokens: 9_000, outputTokens: 700 },
  models: [{ model: 'Example-27B-4bit', requests: 3, promptTokens: 9_000, outputTokens: 700 }], ...patch,
});
const query = (range: UsageQuery['range'], provider = 'omlx'): UsageQuery => ({ provider, range });

test('one read per connection and range per 5 min; each answer carries its own serverNow and the read time', async () => {
  let now = T, reads = 0;
  const cache = new UsageCache(() => now);
  const read = (range: UsageQuery['range']) => async () => { reads += 1; return body(range, now - 50); };
  const first = await cache.get(query('7d'), read('7d'));
  expect(first).toMatchObject({ serverNow: T, cachedAt: T });
  expect(parseUsageV2(first)).toEqual(first);
  now = T + USAGE_CACHE_MS - 1;
  expect(await cache.get(query('7d'), read('7d'))).toMatchObject({ serverNow: now, cachedAt: T });
  expect(reads).toBe(1);
  await cache.get(query('30d'), read('30d'));
  await cache.get(query('7d', 'omlx-2'), read('7d'));
  expect(reads).toBe(3);
  now = T + USAGE_CACHE_MS;
  expect(await cache.get(query('7d'), read('7d'))).toMatchObject({ cachedAt: now });
  expect(reads).toBe(4);
});

test('concurrent requests share one read; a failed read is not cached', async () => {
  let reads = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const cache = new UsageCache(() => T);
  const pending = [1, 2, 3].map(() => cache.get(query('7d'), async () => { reads += 1; await gate; return body('7d', T); }));
  release();
  expect((await Promise.all(pending)).map(item => item.totals.requests)).toEqual([3, 3, 3]);
  expect(reads).toBe(1);
  const failing = new UsageCache(() => T);
  await expect(failing.get(query('90d'), async () => { throw new Error('runtime went away'); })).rejects.toThrow();
  expect(await failing.get(query('90d'), async () => body('90d', T))).toMatchObject({ available: true });
});

test('an unavailable runtime is asked again after 30 s; a refused login keeps the 5 min cache', async () => {
  let now = T, reads = 0;
  const cache = new UsageCache(() => now);
  const unavailable = (reason: NonNullable<UsageV2['reason']>) => async () => {
    reads += 1;
    return body('7d', now, { available: false, reason, buckets: [], models: [], totals: { requests: 0, promptTokens: 0, outputTokens: 0 } });
  };
  await cache.get(query('7d'), unavailable('runtime_unavailable'));
  now = T + USAGE_RETRY_MS;
  await cache.get(query('7d'), unavailable('admin_unauthorized'));
  now = T + USAGE_RETRY_MS * 2;
  expect(await cache.get(query('7d'), unavailable('admin_unauthorized'))).toMatchObject({ reason: 'admin_unauthorized' });
  expect(reads).toBe(2);
});

test('the cache holds at most 32 entries', async () => {
  const cache = new UsageCache(() => T);
  for (let index = 0; index < USAGE_CACHE_ENTRIES + 8; index += 1) await cache.get(query('7d', `omlx-${index}`), async () => body('7d', T));
  expect((cache as unknown as { entries: Map<string, unknown> }).entries.size).toBe(USAGE_CACHE_ENTRIES);
});
