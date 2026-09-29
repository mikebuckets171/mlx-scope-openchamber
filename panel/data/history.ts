import type { HostClient } from '@openchamber/sdk';
import type { FrameReason } from '../../src/contract/reasons.ts';
import type { TrendSeries, TrendV2, TrendWindowMs } from '../../src/contract/trend.ts';
import type { UsageRange, UsageV2 } from '../../src/contract/usage.ts';

// Owner: ui-history. Clients for /v2/trend and /v2/usage. Bodies arrive as strings (S1) and are validated with
// parseTrendV2 / parseUsageV2 before any value reaches the DOM; a 404 is contract_mismatch, 501 "not served yet".

export type HistoryResult<T> = { ok: true; body: T } | { ok: false; reason: FrameReason | 'unparseable' | 'not_served' };
export interface TrendRequest { provider?: string; runtime?: string; windowMs: TrendWindowMs; series: readonly TrendSeries[] }
export interface UsageRequest { provider?: string; range: UsageRange }
export const trendQuery = (request: TrendRequest): Record<string, string> => ({
  ...request.provider ? { provider: request.provider } : {}, ...request.runtime ? { runtime: request.runtime } : {},
  window: String(request.windowMs / 1000), series: request.series.join(','),
});
export const usageQuery = (request: UsageRequest): Record<string, string> => ({
  ...request.provider ? { provider: request.provider } : {}, range: request.range,
});
export class HistoryClient {
  constructor(private readonly host: Pick<HostClient, 'serviceRequest'>) {}
  async trend(request: TrendRequest): Promise<HistoryResult<TrendV2>> { void this.host; void request; return { ok: false, reason: 'not_served' }; }
  async usage(request: UsageRequest): Promise<HistoryResult<UsageV2>> { void request; return { ok: false, reason: 'not_served' }; }
}
