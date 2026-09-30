import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { TurnWindow } from './sessions.ts';

// Owner: attribution. Turn summary (decision 11): shown only when every step is attributed.

export interface TurnSummary {
  wallMs: number;                            // observed wall time minus waits
  modelMs: number | null; toolMs: number | null;   // Turn stats "Model · tool time"
  steps: number;
  firstTtftMs: number | null;
  promptTokens: number | null; cachedTokens: number | null; outputTokens: number;
  decodeTps: number | null;                  // token-weighted Σtok / Σ(tok/tps)
  cacheFraction: number | null;
}

const ATTRIBUTED = new Set(['inferred', 'armed']);
const startOf = (step: CompletionV2): number => step.startedAt ?? step.finishedAt;
/** A total only when every step reports the value; a partial sum would read as the turn's. */
const total = (steps: readonly CompletionV2[], key: 'promptTokens' | 'cachedTokens' | 'outputTokens'): number | null =>
  steps.every(step => step[key] !== undefined) ? steps.reduce((sum, step) => sum + step[key]!, 0) : null;

/** Time some step was running, counted once where steps overlap, clipped to the window. */
const busyMs = (steps: readonly CompletionV2[], from: number, to: number): number | null => {
  if (steps.some(step => step.startedAt === null)) return null;
  let busy = 0, reach = from;
  for (const step of [...steps].sort((a, b) => startOf(a) - startOf(b))) {
    const start = Math.max(startOf(step), reach), end = Math.min(step.finishedAt, to);
    if (end > start) { busy += end - start; reach = end; }
  }
  return busy;
};

/**
 * `steps` must carry their verdicts (the frame's own, applied by the caller). Null unless the window was live-observed
 * from its start, has at least one step, and every step is attributed; `now` summarises a turn still running.
 * Permission and question waits are not observable without the `sessions` capability (S2), so tool time includes them.
 */
export const summarizeTurn = (window: TurnWindow, steps: readonly CompletionV2[], now?: number): TurnSummary | null => {
  const end = window.endedAt ?? now ?? null;
  if (window.startedAt === null || end === null || !steps.length || !steps.every(step => ATTRIBUTED.has(step.verdict?.attr ?? ''))) return null;
  const ordered = [...steps].sort((a, b) => startOf(a) - startOf(b) || a.seq - b.seq), outputTokens = total(ordered, 'outputTokens');
  if (outputTokens === null) return null;
  const wallMs = Math.max(0, end - window.startedAt), modelMs = busyMs(ordered, window.startedAt, end);
  const promptTokens = total(ordered, 'promptTokens'), cachedTokens = total(ordered, 'cachedTokens');
  const decoding = ordered.filter(step => step.outputTokens! > 0);
  const decodeTps = decoding.length && decoding.every(step => (step.decodeTps ?? 0) > 0)
    ? decoding.reduce((sum, step) => sum + step.outputTokens!, 0) / decoding.reduce((sum, step) => sum + step.outputTokens! / step.decodeTps!, 0) : null;
  return {
    wallMs, modelMs, toolMs: modelMs === null ? null : Math.max(0, wallMs - modelMs), steps: ordered.length,
    firstTtftMs: ordered[0]!.ttftMs ?? null, promptTokens, cachedTokens, outputTokens, decodeTps,
    cacheFraction: promptTokens && cachedTokens !== null ? Math.min(1, cachedTokens / promptTokens) : null,
  };
};
