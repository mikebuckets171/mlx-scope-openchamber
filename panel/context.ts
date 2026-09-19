import type { TelemetrySnapshot } from '../src/telemetry.ts';

/** Reported prompt + output against model context, NOT OpenCode compaction or an output allowance. */
export function contextBudget(snapshot: TelemetrySnapshot): {used: number; limit: number; remaining: number; percent: number} | null {
  if (!snapshot.available || !['prefill','decode','processing'].includes(snapshot.phase) || (snapshot.activeRequests ?? 0) > 1) return null;
  const prompt = snapshot.promptTokens, limit = snapshot.contextWindow;
  const output = snapshot.phase === 'prefill' ? 0 : snapshot.completionTokens;
  const valid = (n: number | null): n is number => n !== null && Number.isSafeInteger(n) && n >= 0;
  if (!valid(prompt) || !valid(limit) || limit === 0 || !valid(output)) return null;
  const used = prompt + output;
  if (!Number.isSafeInteger(used) || used > limit) return null;
  return {used, limit, remaining: limit - used, percent: used / limit * 100};
}
