import type { RuntimeKind } from '../../src/contract/runtime.ts';
import type { ReplyRow, SizeBucket } from '../history/ledger-schema.ts';

// Owner: ui-history. Baselines from ledger reply rows (plan §5.6): decode keyed rt|modelRef|ctxBucket, TTFT and prefill
// keyed rt|modelRef|uncachedBucket; 14 days, last 50 values, the current 30 min excluded; p50 needs n ≥ 5, p90 n ≥ 10.
// Excluded: aggregateOf, overlapped (per-request metrics), estimate, gap rows, last-observed (TTFT and tokens).

export const BASELINE_WINDOW_MS = 14 * 86_400_000;
export const BASELINE_VALUES = 50;
export const BASELINE_EXCLUDE_RECENT_MS = 1_800_000;
export const BASELINE_MIN_N = { p50: 5, p90: 10 } as const;
/** `baseline.v2` is written by the leader only when it changes, and at most this often. */
export const BASELINE_WRITE_EVERY_MS = 600_000;
export type BaselineMetric = 'decodeTps' | 'prefillTps' | 'ttftMs' | 'tokPerJ';
export const BASELINE_METRICS: readonly BaselineMetric[] = ['decodeTps', 'prefillTps', 'ttftMs', 'tokPerJ'];
export interface BaselineKey { rt: RuntimeKind; modelRef: number; bucket: SizeBucket }
export interface Baseline { p50: number | null; p90: number | null; n: number }
export type Baselines = ReadonlyMap<string, Baseline>;   // key: `${metric}|${rt}|${modelRef}|${bucket}`
/** The persisted `baseline.v2` value; written only when it changes, at most every 10 min. */
export interface BaselineStoreV2 { v: 2; computedAt: number; entries: Array<[key: string, p50: number | null, p90: number | null, n: number]> }

export const baselineKey = (metric: BaselineMetric, key: BaselineKey): string => `${metric}|${key.rt}|${key.modelRef}|${key.bucket}`;

// Co-factor bits (ledger-schema.ts): 8 overlapped, 16 one counter step covered several requests (aggregateOf).
const OVERLAPPED = 8, AGGREGATE = 16;
/** Decode and tok/J follow the context size; prefill and TTFT follow the input that was not reused from cache. */
const BY_UNCACHED: Readonly<Record<BaselineMetric, boolean>> = { decodeTps: false, tokPerJ: false, prefillTps: true, ttftMs: true };

/** One reply's value for a metric and the size bucket it is compared within, or null when the row can't count. */
export const replyMetric = (row: ReplyRow, metric: BaselineMetric): { value: number; key: BaselineKey } | null => {
  const [, , rt, modelRef, ctxB, uncB, , , output, ttftMs, prefillTps10, decodeTps10, basis, , , cofactors, energyJ10] = row;
  const bucket = BY_UNCACHED[metric] ? uncB : ctxB;
  // Per-request figures from a shared or merged span describe no single reply; estimates are not readings.
  if (modelRef === null || bucket === null || cofactors & (OVERLAPPED | AGGREGATE) || basis === 'estimate') return null;
  const value = metric === 'decodeTps' ? decodeTps10 === null ? null : decodeTps10 / 10
    : metric === 'prefillTps' ? prefillTps10 === null ? null : prefillTps10 / 10
      // A last reading of a request that later disappeared never saw its first token arrive.
      : metric === 'ttftMs' ? basis === 'last-observed' ? null : ttftMs
        : output !== null && energyJ10 !== null && energyJ10 > 0 ? output / (energyJ10 / 10) : null;
  return value !== null && Number.isFinite(value) && value > 0 ? { value, key: { rt, modelRef, bucket } } : null;
};

/** Nearest rank, so every percentile is a value some reply actually had (P3: nothing interpolated). */
export const percentile = (sorted: readonly number[], q: number): number => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;

export const baselineOf = (values: readonly number[]): Baseline => {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { p50: n >= BASELINE_MIN_N.p50 ? percentile(sorted, 0.5) : null, p90: n >= BASELINE_MIN_N.p90 ? percentile(sorted, 0.9) : null, n };
};

/** Rows from the ledger, oldest first. Keys with fewer than 5 values are kept with a null p50, so the UI can say n. */
export const buildBaselines = (rows: readonly ReplyRow[], now: number): Baselines => {
  const from = (now - BASELINE_WINDOW_MS) / 1000, to = (now - BASELINE_EXCLUDE_RECENT_MS) / 1000;
  const values = new Map<string, number[]>();
  // Newest first, so the 50 kept are the most recent.
  const eligible = rows.filter(row => row[1] >= from && row[1] <= to).sort((a, b) => b[1] - a[1]);
  for (const row of eligible) for (const metric of BASELINE_METRICS) {
    const reading = replyMetric(row, metric);
    if (!reading) continue;
    const key = baselineKey(metric, reading.key), list = values.get(key) ?? [];
    if (list.length < BASELINE_VALUES) values.set(key, [...list, reading.value]);
  }
  return new Map([...values].sort(([a], [b]) => a < b ? -1 : 1).map(([key, list]) => [key, baselineOf(list)]));
};
export const baselineFor = (baselines: Baselines, metric: BaselineMetric, key: BaselineKey): Baseline | null =>
  baselines.get(baselineKey(metric, key)) ?? null;

export const baselineStore = (baselines: Baselines, computedAt: number): BaselineStoreV2 =>
  ({ v: 2, computedAt, entries: [...baselines].map(([key, { p50, p90, n }]) => [key, p50, p90, n]) });
const KEY = /^(decodeTps|prefillTps|ttftMs|tokPerJ)\|[a-z-]{2,16}\|\d{1,6}\|[0-4]$/;
const rate = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
/** A stored `baseline.v2`, validated entry by entry; anything malformed is dropped, never thrown. */
export const parseBaselineStore = (value: unknown): { computedAt: number; baselines: Baselines } | null => {
  const item = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (item?.v !== 2 || typeof item.computedAt !== 'number' || !Number.isFinite(item.computedAt) || !Array.isArray(item.entries)) return null;
  const baselines = new Map<string, Baseline>();
  for (const entry of item.entries.slice(0, 2_000)) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !KEY.test(entry[0]) || !Number.isSafeInteger(entry[3]) || entry[3] < 0) continue;
    baselines.set(entry[0], { p50: rate(entry[1]), p90: rate(entry[2]), n: entry[3] });
  }
  return { computedAt: item.computedAt, baselines };
};
/** Whether a write would change what is stored. */
export const sameBaselines = (a: Baselines, b: Baselines): boolean =>
  a.size === b.size && [...a].every(([key, x]) => { const y = b.get(key); return !!y && y.p50 === x.p50 && y.p90 === x.p90 && y.n === x.n; });
