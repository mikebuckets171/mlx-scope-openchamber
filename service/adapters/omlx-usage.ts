import { count, defined, list, modelLabel, obj, opt, type Json } from '../../src/contract/guards.ts';
import { USAGE_MAX_BUCKETS, USAGE_MAX_MODELS, type UsageBucket, type UsageRange, type UsageTotals, type UsageV2 } from '../../src/contract/usage.ts';
import { CONTRACT_VERSION } from '../../src/contract/version.ts';
import type { AdapterContextV2 } from '../core/adapter-v2.ts';
import { HttpFailure } from '../http.ts';
import { adminSession } from './omlx.ts';

// `/admin/api/usage` read-through for `/v2/usage` (svc-history owns the route and its 5 min cache). G1 (SPIKES S6):
// include_details only for today, yesterday and 7d; models ≤ 50. `cache_efficiency` here is a 0–1 ratio (not read).
// Without details oMLX has no per-day request counts: 30d and 90d are day totals from its heatmap (contract §12.3).

export type UsageUnavailable = NonNullable<UsageV2['reason']>;
/** The admin path for a range (and the detail reads); never carries a key. */
export const usagePath = (range: UsageRange | 'today' | 'yesterday', details: boolean): string =>
  `/admin/api/usage?range=${range}${details ? '&include_details=true' : ''}`;
/** Details, and so per-day request counts, only where G1 bounds the body (about 85 KB at worst). */
export const usageDetails = (range: UsageRange | 'today' | 'yesterday'): boolean => range !== '30d' && range !== '90d';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** oMLX's server-local calendar date as 00:00 UTC of that date: a day key that no time zone or DST change can shift. */
export const dayKey = (value: unknown): number | null => {
  const match = typeof value === 'string' ? DATE.exec(value) : null;
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number], at = Date.UTC(year, month - 1, day), date = new Date(at);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? at : null;
};
const sum = (a: number, b: number): number | null => Number.isSafeInteger(a + b) ? a + b : null;

/** A usage summary (`usage_history.py` `_summary`) as contract totals; null unless its counts are whole and ≥ 0. */
const totalsOf = (value: unknown): UsageTotals | null => {
  const item = obj(value), requests = count(item?.requests), prompt = count(item?.prompt_tokens), output = count(item?.completion_tokens);
  return requests !== null && prompt !== null && output !== null
    ? defined({ requests, promptTokens: prompt, cachedTokens: opt(count(item?.cached_tokens)), outputTokens: output }) : null;
};
const detailDay = (value: unknown): UsageBucket | null => {
  const at = dayKey(obj(value)?.date), totals = totalsOf(value), total = totals && sum(totals.promptTokens, totals.outputTokens);
  return at !== null && totals && total !== null ? { at, ...totals, totalTokens: total } : null;
};
/** A heatmap row is prompt + output tokens per local hour; a malformed row is left out, never read as 0. */
const heatmapDay = (value: unknown): UsageBucket | null => {
  const item = obj(value), at = dayKey(item?.date), hours = Array.isArray(item?.tokens) ? item.tokens.map(count) : [];
  if (at === null || !hours.length || hours.length > 25 || hours.some(hour => hour === null)) return null;
  const total = (hours as number[]).reduce<number | null>((a, b) => a === null ? null : sum(a, b), 0);
  return total === null ? null : { at, totalTokens: total };
};
/** Day buckets, oldest first: `daily` when the body has details, else the heatmap's day totals. Null without either. */
export const usageDays = (body: unknown): UsageBucket[] | null => {
  const item = obj(body), rows = Array.isArray(item?.daily) ? list(item.daily, USAGE_MAX_BUCKETS, detailDay)
    : Array.isArray(item?.heatmap) ? list(item.heatmap, USAGE_MAX_BUCKETS, heatmapDay) : null;
  return rows && [...new Map(rows.map(row => [row.at, row])).values()].sort((a, b) => a.at - b.at);
};
const modelRow = (value: unknown): UsageV2['models'][number] | null => {
  const item = obj(value), model = modelLabel(item?.model_id), totals = totalsOf(value);
  return model && totals ? { model, requests: totals.requests, promptTokens: totals.promptTokens, outputTokens: totals.outputTokens } : null;
};

/** The card-hidden body for 401/404/503, recording off, or a non-oMLX connection. */
export const unavailableUsage = (reason: UsageUnavailable, range: UsageRange, now: number): UsageV2 => ({
  contractVersion: 2, serverNow: now, available: false, reason, range, cachedAt: now, basis: 'reported',
  granularity: 'day', buckets: [], totals: { requests: 0, promptTokens: 0, outputTokens: 0 }, models: [],
});
/** Allowlisted fields only; anything else in the body is dropped. Null for a body that is not this range's usage. */
export const normalizeOmlxUsage = (body: unknown, range: UsageRange, now: number): UsageV2 | null => {
  const item = obj(body);
  if (!item || item.range !== range) return null;
  // History switched off at startup: all-zero records that would read as "nothing used".
  if (item.enabled === false) return unavailableUsage('disabled', range, now);
  if (item.available !== true) return unavailableUsage('runtime_unavailable', range, now);
  const totals = totalsOf(item.totals), buckets = usageDays(item);
  if (!totals || !buckets || !Array.isArray(item.models)) return null;
  return { contractVersion: CONTRACT_VERSION, serverNow: now, available: true, range, cachedAt: now, basis: 'reported', granularity: 'day',
    buckets, totals, models: list(item.models, USAGE_MAX_MODELS, modelRow) };
};

/** Answers that stay true until oMLX restarts (an admin refusal already drops the capability through the fallback). */
const HIDDEN: ReadonlySet<UsageUnavailable> = new Set(['route_missing', 'disabled']);
/** One read (admin login included), bounded by the context's budget. Never throws: failures hide the card. */
export const readOmlxUsage = async (context: AdapterContextV2, range: UsageRange): Promise<UsageV2> => {
  const session = adminSession(context), now = context.now();
  let result: UsageV2;
  try {
    const reply = await session.get(usagePath(range, usageDetails(range)), context.monotonic() + context.budgetMs);
    result = reply === 'refused' ? unavailableUsage('admin_unauthorized', range, now)
      : normalizeOmlxUsage(reply.body as Json | null, range, now) ?? unavailableUsage('runtime_unavailable', range, now);
  } catch (error) {
    // 0.6.4 has no usage route; 503 is `usage_history is None` or a failed query (fixture report).
    result = unavailableUsage(error instanceof HttpFailure && error.status === 404 ? 'route_missing' : 'runtime_unavailable', range, now);
  }
  // The snapshot's `server.usage` follows the last answer, so the History tab stops offering a card oMLX won't fill.
  session.usageHidden = !result.available && HIDDEN.has(result.reason!) ? result.reason! : null;
  return result;
};
