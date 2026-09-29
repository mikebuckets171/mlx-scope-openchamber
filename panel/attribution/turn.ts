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
export const summarizeTurn = (window: TurnWindow, steps: readonly CompletionV2[]): TurnSummary | null => {
  void window; void steps;
  return null;
};
