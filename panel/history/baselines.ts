import type { RuntimeKind } from '../../src/contract/runtime.ts';
import type { ReplyRow, SizeBucket } from '../history/ledger-schema.ts';

// Owner: ui-history. Baselines from ledger reply rows (plan §5.6): decode keyed rt|modelRef|ctxBucket, TTFT and prefill
// keyed rt|modelRef|uncachedBucket; 14 days, last 50 values, the current 30 min excluded; p50 needs n ≥ 5, p90 n ≥ 10.
// Excluded: aggregateOf, overlapped (per-request metrics), estimate, gap rows, last-observed (TTFT and tokens).

export const BASELINE_WINDOW_MS = 14 * 86_400_000;
export const BASELINE_VALUES = 50;
export const BASELINE_EXCLUDE_RECENT_MS = 1_800_000;
export type BaselineMetric = 'decodeTps' | 'prefillTps' | 'ttftMs' | 'tokPerJ';
export interface BaselineKey { rt: RuntimeKind; modelRef: number; bucket: SizeBucket }
export interface Baseline { p50: number | null; p90: number | null; n: number }
export type Baselines = ReadonlyMap<string, Baseline>;   // key: `${metric}|${rt}|${modelRef}|${bucket}`
/** The persisted `baseline.v2` value; written only when it changes, at most every 10 min. */
export interface BaselineStoreV2 { v: 2; computedAt: number; entries: Array<[key: string, p50: number | null, p90: number | null, n: number]> }

export const baselineKey = (metric: BaselineMetric, key: BaselineKey): string => `${metric}|${key.rt}|${key.modelRef}|${key.bucket}`;
export const buildBaselines = (rows: readonly ReplyRow[], now: number): Baselines => { void rows; void now; return new Map(); };
export const baselineFor = (baselines: Baselines, metric: BaselineMetric, key: BaselineKey): Baseline | null =>
  baselines.get(baselineKey(metric, key)) ?? null;
