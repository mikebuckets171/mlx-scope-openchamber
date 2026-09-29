import type { UsageRange, UsageV2 } from '../../src/contract/usage.ts';
import type { AdapterContextV2 } from '../core/adapter-v2.ts';

// Owner: ad-omlx. `/admin/api/usage` read-through for `/v2/usage` (svc-history owns the route and its 5 min cache).
// include_details only for today, yesterday and 7d; models ≤ 50; `cache_efficiency` here is a 0–1 ratio.

export type UsageUnavailable = NonNullable<UsageV2['reason']>;
/** The admin path for a range (and the detail reads); never carries a key. */
export const usagePath = (range: UsageRange | 'today' | 'yesterday', details: boolean): string =>
  `/admin/api/usage?range=${range}${details ? '&include_details=true' : ''}`;
/** Allowlisted fields only; anything else in the body is dropped. */
export const normalizeOmlxUsage = (body: unknown, range: UsageRange, now: number): UsageV2 | null => {
  void body; void range; void now;
  return null;
};
/** The card-hidden body for 401/404/503 or a non-oMLX connection. */
export const unavailableUsage = (reason: UsageUnavailable, range: UsageRange, now: number): UsageV2 => ({
  contractVersion: 2, serverNow: now, available: false, reason, range, cachedAt: now, basis: 'reported',
  granularity: range === '7d' ? 'hour' : 'day', buckets: [], totals: { requests: 0, promptTokens: 0, outputTokens: 0 }, models: [],
});
/** One read (admin login included), bounded by the context's budget. */
export const readOmlxUsage = async (context: AdapterContextV2, range: UsageRange): Promise<UsageV2> => {
  void context; void range;
  throw new Error('readOmlxUsage: not implemented (ad-omlx)');
};
