import type { PromptCacheV2 } from '../../src/contract/snapshot.ts';
import type { RegressionFlag } from '../history/regress.ts';
import { dur, kt, tps } from './format.ts';

// Measured insights for the Session section and Live: what the runtime and this Mac reported, never a guessed cause.

export interface Insight { key: 'cache-miss' | 'slower'; text: string; detail: string }

/** A previous reply reused at least this much of its prompt before a cache miss can be named. */
export const CACHE_REUSED_MIN_TOKENS = 4_096;
export const CACHE_REUSED_MIN_SHARE = 0.5;
/** This prompt re-read at least this share of itself. */
export const CACHE_REREAD_MIN_SHARE = 0.75;
/** A miss stays in view this long after its turn ends; the prompt may be read up to this long before the turn is seen. */
export const CACHE_MISS_HOLD_MS = 300_000;
export const CACHE_MISS_LEAD_MS = 2_500;

/**
 * "Prompt cache miss": this chat's previous prompt was mostly reused, and the newest one, at least as long as that reused
 * part (so not a shortened, compacted conversation), was mostly read again. Counts only; the reason is not known.
 * `turn` is this chat's newest turn: the prompt must belong to it, and the row leaves 5 minutes after the turn ends.
 */
export const promptCacheMiss = (cache: PromptCacheV2 | undefined, turn: { startedAt: number | null; endedAt: number | null } | null | undefined, now: number): Insight | null => {
  const latest = cache?.latest, previous = cache?.previous;
  if (!latest || !previous || turn?.startedAt == null || latest.observedAt < turn.startedAt - CACHE_MISS_LEAD_MS) return null;
  if (turn.endedAt !== null && now - turn.endedAt > CACHE_MISS_HOLD_MS) return null;
  const reread = latest.total - latest.cache;
  if (previous.cache < Math.max(CACHE_REUSED_MIN_TOKENS, CACHE_REUSED_MIN_SHARE * previous.total)) return null;
  if (reread < CACHE_REREAD_MIN_SHARE * latest.total || latest.total < previous.cache) return null;
  return { key: 'cache-miss', text: `Prompt cache miss · re-read ${kt(reread)} of ${kt(latest.total)}`,
    detail: `This prompt re-read ${kt(reread)} of ${kt(latest.total)} tokens; this chat’s previous prompt reused ${kt(previous.cache)}. `
      + 'Both counts are reported by the engine. Scope does not know why the cache was not reused.' };
};

// Co-factor bits: 1 pressure, 2 swap grew, 4 thermal (stored); 32 requests queued, 64 a media job (in memory only).
const OBSERVED: ReadonlyArray<[bit: number, text: string]> = [[1, 'memory pressure'], [2, 'swap growth'], [4, 'heat'], [32, 'requests queued'], [64, 'a media job running']];
const METRIC: Readonly<Record<RegressionFlag['metric'], { label: string; value: (n: number) => string }>> = {
  decodeTps: { label: 'Slower than usual', value: n => `${tps(n)} tok/s` },
  prefillTps: { label: 'Prompt reading slower than usual', value: n => `${tps(n)} tok/s` },
  ttftMs: { label: 'First token slower than usual', value: dur },
  tokPerJ: { label: 'Less efficient than usual', value: n => `${n.toFixed(2)} tok/J` },
};

/** One flag for the monitored model, generation speed first, with what was observed during those replies. */
export const slowdown = (flags: readonly RegressionFlag[]): Insight | null => {
  const flag = flags.find(item => item.metric === 'decodeTps') ?? flags[0];
  if (!flag) return null;
  const copy = METRIC[flag.metric], observed = OBSERVED.filter(([bit]) => flag.cofactors & bit).map(([, text]) => text);
  return { key: 'slower', text: `${copy.label} · ${copy.value(flag.recentMedian)} vs ${copy.value(flag.p50)}`,
    detail: `Middle of the last 3 replies against the usual for this model and size, from ${flag.n} replies. `
      + (observed.length ? `Observed during: ${observed.join(', ')}. These were present at the time; Scope does not know they caused it.`
        : 'No measured condition on this Mac was present during those replies.') };
};
