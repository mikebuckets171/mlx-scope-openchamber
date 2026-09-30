import type { HostClient } from '@openchamber/sdk';
import { nonneg, obj } from '../src/contract/guards.ts';
import { runtimeKind } from '../src/contract/runtime.ts';
import type { BaselineMetric } from '../panel/history/baselines.ts';
import type { VsUsual } from '../panel/history/regress.ts';
import { lastReply, sizeBucket } from '../panel/share/scope.ts';

// Owner: scope-flip. "vs usual" for /scope (plan §5.8): the last finished reply against the persisted `baseline.v2`,
// read-only. The keys follow the ledger rows (INTERFACES §4.5): modelRef is the index in the `ledger.v2.models`
// string list, decode is keyed by the context bucket of prompt + output (as `replyRow` files it), prefill and TTFT by the uncached-prompt bucket.
// Model names are only compared here, never returned.

export const MIN_BASELINE_N = 5;
// `KEYS.baseline`/`KEYS.models` (ledger-schema.ts), `sizeBucket` (ledger-schema.ts, restated in scope.ts) and
// `baselineKey` (baselines.ts), restated so their modules' future code never lands in the 25 KB bundle; usual.test.ts
// pins each one to the original.
export const USUAL_KEYS = ['baseline.v2', 'ledger.v2.models'] as const;
export const baselineKey = (metric: BaselineMetric, rt: string, modelRef: number, bucket: number): string => `${metric}|${rt}|${modelRef}|${bucket}`;
type Storage = Pick<HostClient['storage'], 'get'>;

/** Deltas for `snapshot`'s last reply; `[]` without a matching baseline. Per-request metrics skip aggregate, overlapped and estimate replies; TTFT also last-observed ones. */
export const usualFor = (snapshot: unknown, baseline: unknown, models: unknown): VsUsual[] => {
  const reply = lastReply(snapshot), store = obj(baseline), rt = runtimeKind(obj(obj(snapshot)?.connection)?.runtime);
  if (!reply || !rt || store?.v !== 2 || !Array.isArray(store.entries) || !Array.isArray(models)) return [];
  const modelRef = typeof reply.model === 'string' ? models.indexOf(reply.model) : -1;
  if (modelRef < 0 || reply.overlapped || (nonneg(reply.aggregateOf) ?? 0) > 1 || reply.basis === 'estimate') return [];
  const prompt = nonneg(reply.promptTokens), cached = nonneg(reply.cachedTokens);
  const ctxB = sizeBucket(prompt === null ? null : prompt + (nonneg(reply.outputTokens) ?? 0)), uncB = prompt !== null && cached !== null && cached <= prompt ? sizeBucket(prompt - cached) : null;
  const entries = new Map(store.entries.filter(Array.isArray).map(entry => [entry[0], entry] as const));
  const delta = (metric: BaselineMetric, value: number | null, bucket: number | null): VsUsual | null => {
    const entry = value === null || bucket === null ? undefined : entries.get(baselineKey(metric, rt, modelRef, bucket));
    const p50 = nonneg(entry?.[1]), n = nonneg(entry?.[3]);
    return value !== null && p50 && n !== null && n >= MIN_BASELINE_N ? { metric, ratio: value / p50, n, basis: 'reported' } : null;
  };
  return [delta('decodeTps', nonneg(reply.decodeTps), ctxB), delta('prefillTps', nonneg(reply.prefillTps), uncB),
    reply.basis === 'last-observed' ? null : delta('ttftMs', nonneg(reply.ttftMs), uncB)].filter(item => item !== null);
};

/** Two storage reads, never a write; null when storage cannot be read (not approved, disabled, or rejected). */
export const readUsual = async (storage: Storage, snapshot: Promise<unknown>): Promise<VsUsual[] | null> => {
  const stored = await Promise.all(USUAL_KEYS.map(key => storage.get(key))).catch(() => null);
  return stored && usualFor(await snapshot, stored[0], stored[1]);
};
