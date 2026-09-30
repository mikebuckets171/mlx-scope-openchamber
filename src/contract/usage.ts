import { at, bool, classAKeys, count, defined, list, modelLabel, obj, oneOf, opt } from './guards.ts';
import { CONTRACT_VERSION } from './version.ts';

export const USAGE_RANGES = ['7d', '30d', '90d'] as const;
export type UsageRange = typeof USAGE_RANGES[number];
export const USAGE_REASONS = ['admin_unauthorized', 'route_missing', 'runtime_unavailable', 'not_omlx', 'disabled'] as const;
export const USAGE_MAX_MODELS = 50;
export const USAGE_MAX_BUCKETS = 400;       // oMLX serves day buckets (90 at most); 7d hourly would be 168

export interface UsageTotals { requests: number; promptTokens: number; cachedTokens?: number; outputTokens: number }
/**
 * One day (or hour). §12.3: oMLX has per-day request and token splits only with `include_details` (7d); 30d and 90d
 * come from its heatmap, which holds prompt + output tokens alone. A figure the runtime did not record is absent, never
 * 0. `totalTokens` is prompt + output; a bucket carries it, or both `promptTokens` and `outputTokens`.
 */
export interface UsageBucket { at: number; requests?: number; promptTokens?: number; cachedTokens?: number; outputTokens?: number; totalTokens?: number }
export interface UsageV2 {
  contractVersion: 2;
  serverNow: number;
  available: boolean;
  reason?: typeof USAGE_REASONS[number];     // the card is hidden on 401/404/503 and while oMLX records nothing
  range: UsageRange;
  cachedAt: number;                          // 5 min cache
  basis: 'reported';                         // "Recorded by oMLX"; never merged into the ledger; no TTFT
  granularity: 'hour' | 'day';
  buckets: UsageBucket[];                    // oldest first; `at` of a day bucket is 00:00 UTC of oMLX's local date (§12.3)
  totals: UsageTotals;
  models: Array<{ model: string; requests: number; promptTokens: number; outputTokens: number }>;   // ≤ 50
}

const totals = (value: unknown): UsageTotals | null => {
  const item = obj(value), requests = count(item?.requests), prompt = count(item?.promptTokens), output = count(item?.outputTokens);
  return requests !== null && prompt !== null && output !== null
    ? defined({ requests, promptTokens: prompt, cachedTokens: opt(count(item?.cachedTokens)), outputTokens: output }) : null;
};

const BUCKET_COUNTS = ['requests', 'promptTokens', 'cachedTokens', 'outputTokens', 'totalTokens'] as const;
/** A present count must be valid (a malformed row is dropped whole); a bucket needs a total or both halves. */
const bucket = (value: unknown): UsageBucket | null => {
  const item = obj(value), when = at(item?.at);
  if (!item || when === null || BUCKET_COUNTS.some(key => item[key] !== undefined && count(item[key]) === null)) return null;
  const row = defined({ at: when, ...Object.fromEntries(BUCKET_COUNTS.map(key => [key, opt(count(item[key]))])) }) as UsageBucket;
  return row.totalTokens !== undefined || row.promptTokens !== undefined && row.outputTokens !== undefined ? row : null;
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
    buckets: list(item.buckets, USAGE_MAX_BUCKETS, bucket),
    totals: sum,
    models: list(item.models, USAGE_MAX_MODELS, raw => {
      const row = obj(raw), model = modelLabel(row?.model), requests = count(row?.requests), prompt = count(row?.promptTokens), output = count(row?.outputTokens);
      return model && requests !== null && prompt !== null && output !== null ? { model, requests, promptTokens: prompt, outputTokens: output } : null;
    }),
  });
};
