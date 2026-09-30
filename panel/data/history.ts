import type { HostClient } from '@openchamber/sdk';
import { obj } from '../../src/contract/guards.ts';
import { FRAME_REASONS, type FrameReason } from '../../src/contract/reasons.ts';
import { parseTrendV2, type TrendSeries, type TrendV2, type TrendWindowMs } from '../../src/contract/trend.ts';
import { parseUsageV2, type UsageRange, type UsageV2 } from '../../src/contract/usage.ts';
import { CONTRACT_VERSION, ROUTES } from '../../src/contract/version.ts';
import { unavailableForHostError } from '../host-errors.ts';

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

/** The host's own refusal reasons in the contract's frame vocabulary; a refused grant is the needs-approval state. */
const frameReason = (reason: string): FrameReason => reason === 'service_not_granted' ? 'needs_approval'
  : (FRAME_REASONS as readonly string[]).includes(reason) ? reason as FrameReason : 'host_unavailable';

const read = async <T>(host: Pick<HostClient, 'serviceRequest'>, path: string, query: Record<string, string>,
  parse: (value: unknown) => T | null): Promise<HistoryResult<T>> => {
  let response: Awaited<ReturnType<HostClient['serviceRequest']>>;
  try { response = await host.serviceRequest({ method: 'GET', path, query }); }
  catch (error) { return { ok: false, reason: frameReason(unavailableForHostError(error).reason) }; }
  // A still-running 1.6 service has no /v2 routes; a 2.0 service without the route wired answers 501.
  if (response.status === 404) return { ok: false, reason: 'contract_mismatch' };
  if (response.status === 501) return { ok: false, reason: 'not_served' };
  if (response.status !== 200) return { ok: false, reason: 'service_failed' };
  let value: unknown;
  try { value = typeof response.body === 'string' ? JSON.parse(response.body) : response.body; }
  catch { return { ok: false, reason: 'unparseable' }; }
  const version = obj(value)?.contractVersion;
  if (version !== undefined && version !== CONTRACT_VERSION) return { ok: false, reason: 'contract_mismatch' };
  const body = parse(value);
  return body ? { ok: true, body } : { ok: false, reason: 'unparseable' };
};

export class HistoryClient {
  constructor(private readonly host: Pick<HostClient, 'serviceRequest'>) {}
  trend(request: TrendRequest): Promise<HistoryResult<TrendV2>> { return read(this.host, ROUTES.trend, trendQuery(request), parseTrendV2); }
  usage(request: UsageRequest): Promise<HistoryResult<UsageV2>> { return read(this.host, ROUTES.usage, usageQuery(request), parseUsageV2); }
}
