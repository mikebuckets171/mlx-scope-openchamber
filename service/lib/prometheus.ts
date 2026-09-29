// Owner: ad-llama-ollama. Prometheus text 0.0.4 (plan §5.3): bounded, name-allowlisted; label values never reach the wire.

export const PROMETHEUS_MAX_BYTES = 2 * 1024 * 1024;
export const PROMETHEUS_MAX_SAMPLES = 5_000;
export type PromType = 'counter' | 'gauge' | 'histogram' | 'summary' | 'untyped';
export interface PromSample { name: string; labels: Readonly<Record<string, string>>; value: number }   // NaN and ±Inf kept as numbers
export interface PromParse { samples: PromSample[]; types: ReadonlyMap<string, PromType>; truncated: boolean }
export interface PromOptions { allow: (name: string) => boolean; maxBytes?: number; maxSamples?: number }
export interface PromHistogram { buckets: Array<[le: number, count: number]>; sum: number; count: number }

/** Parses exposition text, keeping only allowlisted names (a family's `_bucket`/`_sum`/`_count` follow its base name). */
export const parsePrometheus = (text: string, options: PromOptions): PromParse => {
  void text; void options;
  return { samples: [], types: new Map(), truncated: false };
};
/** The first sample with this name whose labels include `labels`; null when absent or not finite. */
export const sampleValue = (parse: PromParse, name: string, labels: Readonly<Record<string, string>> = {}): number | null => {
  void parse; void name; void labels;
  return null;
};
/** A histogram family by base name, buckets ordered by `le`; null when incomplete. */
export const histogram = (parse: PromParse, name: string): PromHistogram | null => {
  void parse; void name;
  return null;
};
