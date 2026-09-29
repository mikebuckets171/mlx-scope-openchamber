import type { Baselines } from './baselines.ts';

// Owner: ui-history. "Copy baseline summary" (decision 11): sanitized through panel/share/report.ts, models aliased
// "Model A/B…", ≤ 32,000 chars, no model names (class B).

export const SUMMARY_MAX_CHARS = 32_000;
export const baselineSummary = (baselines: Baselines, models: readonly string[], version: string, now: number): string => {
  void baselines; void models; void version; void now;
  throw new Error('baselineSummary: not implemented (ui-history)');
};
