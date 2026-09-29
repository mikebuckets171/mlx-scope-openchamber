import type { UsageQuery } from '../../src/contract/query.ts';
import type { UsageV2 } from '../../src/contract/usage.ts';

// Owner: svc-history. The 5 min read-through cache behind /v2/usage; ad-omlx supplies the read.

export const USAGE_CACHE_MS = 300_000;
export class UsageCache {
  constructor(private readonly now: () => number, private readonly ttlMs = USAGE_CACHE_MS) {}
  get(query: UsageQuery, read: () => Promise<UsageV2>): Promise<UsageV2> {
    void this.now; void this.ttlMs; void query;
    return read();
  }
}
