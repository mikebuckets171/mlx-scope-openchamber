import { at, bool, classAKeys, count, defined, list, modelLabel, obj, oneOf, opt } from './guards.ts';
import { CONTRACT_VERSION } from './version.ts';

export const USAGE_RANGES = ['7d', '30d', '90d'] as const;
export type UsageRange = typeof USAGE_RANGES[number];
export const USAGE_REASONS = ['admin_unauthorized', 'route_missing', 'runtime_unavailable', 'not_omlx'] as const;
export const USAGE_MAX_MODELS = 50;
export const USAGE_MAX_BUCKETS = 400;       // 7d hourly is 168; 30d and 90d are daily

export interface UsageTotals { requests: number; promptTokens: number; cachedTokens?: number; outputTokens: number }
export interface UsageV2 {
  contractVersion: 2;
  serverNow: number;
  available: boolean;
  reason?: typeof USAGE_REASONS[number];     // the card is hidden on 401/404/503
  range: UsageRange;
  cachedAt: number;                          // 5 min cache
  basis: 'reported';                         // "Recorded by oMLX"; never merged into the ledger; no TTFT
  granularity: 'hour' | 'day';
  buckets: Array<{ at: number } & UsageTotals>;
  totals: UsageTotals;
  models: Array<{ model: string; requests: number; promptTokens: number; outputTokens: number }>;   // ≤ 50
}

const totals = (value: unknown): UsageTotals | null => {
  const item = obj(value), requests = count(item?.requests), prompt = count(item?.promptTokens), output = count(item?.outputTokens);
  return requests !== null && prompt !== null && output !== null
    ? defined({ requests, promptTokens: prompt, cachedTokens: opt(count(item?.cachedTokens)), outputTokens: output }) : null;
};

export const parseUsageV2 = (value: unknown): UsageV2 | null => {
  const item = obj(value), serverNow = at(item?.serverNow), cachedAt = at(item?.cachedAt), available = bool(item?.available);
  const range = oneOf(USAGE_RANGES)(item?.range), granularity = oneOf(['hour', 'day'] as const)(item?.granularity), sum = totals(item?.totals);
  const reason = oneOf(USAGE_REASONS)(item?.reason);
  if (!item || item.contractVersion !== CONTRACT_VERSION || classAKeys(item).length || serverNow === null || cachedAt === null
    || available === null || !range || !granularity || item.basis !== 'reported' || !sum || !Array.isArray(item.buckets) || !Array.isArray(item.models)
    // An unavailable card must say why, so the panel can hide it for the right reason.
    || !available && !reason) return null;
  return defined({
    contractVersion: CONTRACT_VERSION, serverNow, available, reason: available ? undefined : reason!, range, cachedAt, basis: 'reported' as const, granularity,
    buckets: list(item.buckets, USAGE_MAX_BUCKETS, raw => { const when = at(obj(raw)?.at), row = totals(raw); return when !== null && row ? { at: when, ...row } : null; }),
    totals: sum,
    models: list(item.models, USAGE_MAX_MODELS, raw => {
      const row = obj(raw), model = modelLabel(row?.model), requests = count(row?.requests), prompt = count(row?.promptTokens), output = count(row?.outputTokens);
      return model && requests !== null && prompt !== null && output !== null ? { model, requests, promptTokens: prompt, outputTokens: output } : null;
    }),
  });
};
