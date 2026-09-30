import type { RuntimeKind } from '../../src/contract/runtime.ts';
import { at, count, finite, obj } from '../../src/contract/guards.ts';
import { COFACTOR, type ReplyRow, type SizeBucket } from '../history/ledger-schema.ts';

// Owner: ui-history (logic built by the ledger track). Baselines from ledger reply rows (plan §5.6): decode keyed
// rt|modelRef|ctxBucket, TTFT and prefill keyed rt|modelRef|uncachedBucket; 14 days, last 50 values, the current 30 min
// excluded; p50 needs n ≥ 5, p90 n ≥ 10. Excluded: aggregateOf, overlapped (per-request metrics), estimate, gap rows,
// last-observed (TTFT and tokens). tok/J is a separate baseline labelled "estimate" (macmon chip power).

export const BASELINE_WINDOW_MS = 14 * 86_400_000;
export const BASELINE_VALUES = 50;
export const BASELINE_EXCLUDE_RECENT_MS = 1_800_000;
export const BASELINE_MIN_N = { p50: 5, p90: 10 } as const;
/** `baseline.v2` is rewritten only when it changes, and at most this often. */
export const BASELINE_WRITE_MS = 600_000;
export type BaselineMetric = 'decodeTps' | 'prefillTps' | 'ttftMs' | 'tokPerJ';
export const BASELINE_METRICS: readonly BaselineMetric[] = ['decodeTps', 'prefillTps', 'ttftMs', 'tokPerJ'];
export interface BaselineKey { rt: RuntimeKind; modelRef: number; bucket: SizeBucket }
export interface Baseline { p50: number | null; p90: number | null; n: number }
export type Baselines = ReadonlyMap<string, Baseline>;   // key: `${metric}|${rt}|${modelRef}|${bucket}`
/** The persisted `baseline.v2` value; written only when it changes, at most every 10 min. */
export interface BaselineStoreV2 { v: 2; computedAt: number; entries: Array<[key: string, p50: number | null, p90: number | null, n: number]> }

export const baselineKey = (metric: BaselineMetric, key: BaselineKey): string => `${metric}|${key.rt}|${key.modelRef}|${key.bucket}`;
/** tok/J is decode-speed-like (keyed by context); TTFT and prefill depend on the uncached prompt. */
export const bucketFor = (metric: BaselineMetric, row: ReplyRow): SizeBucket | null => metric === 'decodeTps' || metric === 'tokPerJ' ? row[4] : row[5];
export const rowKey = (metric: BaselineMetric, row: ReplyRow): BaselineKey | null => {
  const bucket = bucketFor(metric, row);
  return row[3] === null || bucket === null ? null : { rt: row[2], modelRef: row[3], bucket };
};
/** A reply's value for one metric, in the metric's own unit; null when the row does not carry it. */
export const metricValue = (row: ReplyRow, metric: BaselineMetric): number | null => {
  if (metric === 'decodeTps') return row[11] === null ? null : row[11] / 10;
  if (metric === 'prefillTps') return row[10] === null ? null : row[10] / 10;
  if (metric === 'ttftMs') return row[9];
  return row[8] !== null && row[16] !== null && row[16] > 0 ? row[8] / (row[16] / 10) : null;
};
/**
 * Whether a reply may count toward (or be compared with) a baseline for this metric. Overlap and aggregation make every
 * per-request figure a share of several requests; `estimate` rows have no reported speed; a `last-observed` row is the
 * request's last reading before it left view, so its TTFT and token counts are not final.
 */
export const eligible = (row: ReplyRow, metric: BaselineMetric): boolean =>
  row[12] !== 'estimate' && (row[15] & (COFACTOR.overlapped | COFACTOR.aggregate)) === 0
  && !(row[12] === 'last-observed' && (metric === 'ttftMs' || metric === 'tokPerJ'));

/** Linear interpolation between closest ranks (R-7), over values sorted ascending. */
export const percentile = (sorted: readonly number[], p: number): number => {
  const position = (sorted.length - 1) * p, low = Math.floor(position), high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
};
export const baselineOf = (values: readonly number[]): Baseline => {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { p50: n >= BASELINE_MIN_N.p50 ? percentile(sorted, 0.5) : null, p90: n >= BASELINE_MIN_N.p90 ? percentile(sorted, 0.9) : null, n };
};

export const buildBaselines = (rows: readonly ReplyRow[], now: number): Baselines => {
  const fromS = (now - BASELINE_WINDOW_MS) / 1000, toS = (now - BASELINE_EXCLUDE_RECENT_MS) / 1000;
  const ordered = rows.filter(row => row[0] === 'r' && row[1] >= fromS && row[1] < toS).sort((a, b) => a[1] - b[1]);
  const series = new Map<string, number[]>();
  for (const row of ordered) for (const metric of BASELINE_METRICS) {
    const key = rowKey(metric, row), value = metricValue(row, metric);
    if (!key || value === null || !Number.isFinite(value) || !eligible(row, metric)) continue;
    const name = baselineKey(metric, key), values = series.get(name) ?? [];
    values.push(value);
    series.set(name, values);
  }
  const result = new Map<string, Baseline>();
  for (const [name, values] of [...series].sort(([a], [b]) => a < b ? -1 : 1)) result.set(name, baselineOf(values.slice(-BASELINE_VALUES)));
  return result;
};
export const baselineFor = (baselines: Baselines, metric: BaselineMetric, key: BaselineKey): Baseline | null =>
  baselines.get(baselineKey(metric, key)) ?? null;

export const toBaselineStore = (baselines: Baselines, now: number): BaselineStoreV2 =>
  ({ v: 2, computedAt: now, entries: [...baselines].map(([key, value]) => [key, value.p50, value.p90, value.n]) });
const KEY = /^(decodeTps|prefillTps|ttftMs|tokPerJ)\|[a-z-]{1,16}\|\d{1,4}\|[0-4]$/;
const stat = (value: unknown): number | null | undefined => value === null ? null : finite(value) ?? undefined;
export const parseBaselineStore = (value: unknown): { computedAt: number; baselines: Baselines } | null => {
  const item = obj(value), computedAt = at(item?.computedAt);
  if (!item || item.v !== 2 || computedAt === null || !Array.isArray(item.entries)) return null;
  const baselines = new Map<string, Baseline>();
  for (const entry of item.entries.slice(0, 4_096)) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !KEY.test(entry[0])) continue;
    const p50 = stat(entry[1]), p90 = stat(entry[2]), n = count(entry[3]);
    if (p50 !== undefined && p90 !== undefined && n !== null) baselines.set(entry[0], { p50, p90, n });
  }
  return { computedAt, baselines };
};
export const sameBaselines = (a: Baselines, b: Baselines): boolean =>
  a.size === b.size && [...a].every(([key, value]) => { const other = b.get(key); return !!other && other.p50 === value.p50 && other.p90 === value.p90 && other.n === value.n; });
