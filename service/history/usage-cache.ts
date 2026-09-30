import type { UsageQuery } from '../../src/contract/query.ts';
import type { UsageV2 } from '../../src/contract/usage.ts';

// Owner: svc-history. The 5 min read-through cache behind /v2/usage; ad-omlx supplies the read.

export const USAGE_CACHE_MS = 300_000;
/** A runtime that did not answer is asked again sooner, so the card comes back soon after the runtime does. */
export const USAGE_RETRY_MS = 30_000;
export const USAGE_CACHE_ENTRIES = 32;
const keyOf = (query: UsageQuery): string => `${query.provider ?? ''}\0${query.runtime ?? ''}\0${query.range}`;

/**
 * One read per connection and range per 5 min, shared by concurrent requests; nothing runs without a request. A failed
 * read is not cached. `cachedAt` is when the read finished; `serverNow` is the time of each answer.
 */
export class UsageCache {
  private readonly entries = new Map<string, UsageV2>();
  private readonly flights = new Map<string, Promise<UsageV2>>();
  constructor(private readonly now: () => number, private readonly ttlMs = USAGE_CACHE_MS) {}

  async get(query: UsageQuery, read: () => Promise<UsageV2>): Promise<UsageV2> {
    const key = keyOf(query), now = this.now(), hit = this.entries.get(key);
    const ttl = hit?.reason === 'runtime_unavailable' ? Math.min(this.ttlMs, USAGE_RETRY_MS) : this.ttlMs;
    if (hit && now >= hit.cachedAt && now - hit.cachedAt < ttl) return { ...hit, serverNow: now };
    let flight = this.flights.get(key);
    if (!flight) {
      flight = read().then(body => {
        const cached = { ...body, cachedAt: this.now() };
        this.entries.delete(key);
        this.entries.set(key, cached);
        for (const stale of this.entries.keys()) { if (this.entries.size <= USAGE_CACHE_ENTRIES) break; this.entries.delete(stale); }
        return cached;
      }).finally(() => { this.flights.delete(key); });
      this.flights.set(key, flight);
    }
    return { ...await flight, serverNow: this.now() };
  }
}
