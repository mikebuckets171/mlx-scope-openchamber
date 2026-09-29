// Test support only: the 1.6 panel's pure functions, frozen verbatim at v1.6.1 (their v1 inputs, decimal GB and
// seconds). They are the parity oracle for the 2a panel, which computes the same values from v2 (panel/present/*),
// and they render the 1.6 projection the converter round trip compares.
import type { SystemSnapshot } from '../../system.ts';
import type { AvailableTelemetry, TelemetrySnapshot } from '../../telemetry.ts';

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

/** Current runtime stage only. Cache reuse is separate; elapsed time never advances this. */
export const prefillReading = (snapshot: AvailableTelemetry | null) => {
  if (snapshot?.phase !== 'prefill') return null;
  const progress = snapshot.prefillProgress;
  if (progress === null || !Number.isFinite(progress) || progress < 0 || progress > 1) {
    return { percent: null, remaining: 'Progress unavailable', completed: 'Waiting for token counts', counts: null, stale: snapshot.prefillProgressStale };
  }
  // Do not round an incomplete stage to 0% remaining / 100% complete.
  const left = (1 - progress) * 100;
  // Decimal percentages such as 58 / 100 may land a few ulps below an integer.
  const whole = progress === 1 ? 100 : Math.min(99, Math.floor(progress * 100 + Number.EPSILON * 100));
  const remaining = left > 0 && left < 1 ? '<1%' : `${100 - whole}%`;
  const completed = progress > 0.99 && progress < 1 ? '>99%' : `${whole}%`;
  const done = snapshot.prefillProcessedTokens, total = snapshot.prefillTotalTokens;
  const counts = done !== null && total !== null ? { done, total, remaining: total - done } : null;
  return { percent: progress * 100, remaining: `${remaining} remaining`, completed: `${completed} complete`, counts, stale: snapshot.prefillProgressStale };
};

const safe = (value: number | null): number | null => value !== null && Number.isFinite(value) && value >= 0 ? value : null;
/** Runtime estimate only, updated with samples; never a ticking countdown or a completion promise. */
export const prefillEstimate = (snapshot: AvailableTelemetry | null): string | null => {
  if (!snapshot || snapshot.phase !== 'prefill' || snapshot.prefillProgressStale || snapshot.prefillProgress === null
    || snapshot.prefillProgress >= 1 || (snapshot.livePrefillTPS ?? 0) <= 0) return null;
  const seconds = safe(snapshot.prefillETASeconds);
  if (seconds === null) return null;
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `~${Math.ceil(seconds / 5) * 5}s`;
  if (seconds < 3600) return `~${Math.ceil(seconds / 60)}m`;
  if (seconds < 86400) return `~${(seconds / 3600).toFixed(1)}h`;
  return '>24h';
};

export const cacheSplit = (snapshot: AvailableTelemetry | null) => {
  const total = snapshot?.promptTokens ?? null, reused = snapshot?.cachedTokens ?? null;
  if (total === null || reused === null || !Number.isSafeInteger(total) || !Number.isSafeInteger(reused)
    || total <= 0 || reused < 0 || reused > total) return null;
  return { total, reused, fresh: total - reused, percent: reused / total * 100 };
};

/** Copy only an allowlist of measurements. No raw messages, names, paths, keys or IDs. */
export const measurementReport = (snapshot: TelemetrySnapshot, system: SystemSnapshot | null, paused: boolean | 'refreshing', version: string, now = Date.now()): string => {
  const scalar = (value: number | null | undefined, unit = '') => value == null || !Number.isFinite(value) ? 'not reported' : `${Number(value.toFixed(2))}${unit}`;
  const lines = [`MLX Scope ${version} — OpenChamber extension`, 'Scope: runtime server / whole host, not a selected chat',
    `State: ${paused === 'refreshing' ? 'refreshing — held observations' : paused ? 'paused — held observations' : snapshot.available ? snapshot.phase : 'unavailable'}`,
    `Sample age: ${scalar(Math.max(0, (now - snapshot.sampledAt) / 1000), ' seconds')}`];
  if (!snapshot.available) lines.push(`Connection: ${snapshot.reason}`);
  if (snapshot.available) {
    const budget = contextBudget(snapshot);
    if (budget) lines.push(`Model context: ${budget.used} / ${budget.limit}; ${budget.remaining} tokens to reported limit (not OpenCode compaction or output budget)`);
    const progress = prefillReading(snapshot);
    if (progress) {
      lines.push(`Prefill: ${progress.remaining}${progress.stale || paused ? ' (last reading)' : ''} — current stage only`);
      if (!paused && !progress.stale && snapshot.prefillETASeconds !== null) lines.push(`Prefill stage estimate: ${scalar(snapshot.prefillETASeconds, ' seconds')} (reported stage estimate, not a completion deadline)`);
      if (progress.counts) lines.push(`Prefill tokens: ${progress.counts.done} / ${progress.counts.total}; ${progress.counts.remaining} remaining`);
    }
    // Only measured values are listed; a runtime's unreported fields are simply left out.
    const measured = (label: string, value: number | null | undefined, unit = '') => { if (value != null && Number.isFinite(value)) lines.push(`${label}: ${scalar(value, unit)}`); };
    measured('Generation (request average)', snapshot.liveDecodeTPS, ' tok/s');
    measured('Prefill (reported speed)', snapshot.livePrefillTPS, ' tok/s');
    measured('Prompt tokens', snapshot.promptTokens); measured('Cached tokens', snapshot.cachedTokens);
    measured('Output tokens', snapshot.completionTokens); measured('Elapsed', snapshot.elapsedSeconds, ' seconds');
    measured('Active requests', snapshot.activeRequests); measured('Queued requests', snapshot.queuedRequests);
    const last = snapshot.lastRequest;
    if (last) {
      measured('Last response speed (exact)', last.tokensPerSecond, ' tok/s'); measured('Last response first token', last.ttftSeconds, ' seconds');
      measured('Last response prompt tokens', last.promptTokens); measured('Last response cached tokens', last.cachedTokens);
      measured('Last response output tokens', last.outputTokens);
    }
    if (snapshot.runtime === 'splash' && snapshot.serverStats) {
      const stats = snapshot.serverStats;
      if (stats.ready !== null) lines.push(`Splash ready: ${stats.ready ? 'yes' : 'no (loading)'}`);
      measured('Splash server decode (all requests)', stats.aggregateDecodeTokensPerSecond, ' tok/s');
      measured('Splash completed requests since start', stats.completedRequests);
      measured('Splash failed requests since start', stats.failedRequests);
      measured('Splash GPU memory (Metal) · now', stats.metalCurrentGB == null ? null : stats.metalCurrentGB * 1e9 / 1024 ** 3, ' GiB');
      measured('Splash GPU memory (Metal) · peak', stats.metalPeakGB == null ? null : stats.metalPeakGB * 1e9 / 1024 ** 3, ' GiB');
    }
  }
  if (system) {
    lines.push(`Host sample age: ${scalar(Math.max(0, (now - system.sampledAt) / 1000), ' seconds')}`,
      `CPU: ${scalar(system.cpuPercent, '%')}`,
      `Non-free RAM: ${scalar(system.memoryUsedGB == null ? null : system.memoryUsedGB * 1e9 / 1024 ** 3, ' GiB')} (includes reclaimable pages; not memory pressure)`);
    if (system.macOS) lines.push(`Native sample age: ${scalar(Math.max(0, (now - system.macOS.sampledAt) / 1000), ' seconds')}`,
      `Swap used: ${scalar(system.macOS.swapUsedGB == null ? null : system.macOS.swapUsedGB * 1e9 / 1024 ** 3, ' GiB')}`);
  }
  return lines.join('\n');
};

const gib = (value: number | null | undefined): number | null => value == null ? null : value * 1e9 / 1024 ** 3;
export const snapshotObservation = (snapshot: TelemetrySnapshot, held: boolean, recentOutput: number | null, now = Date.now()) => {
  const current = snapshot.available ? snapshot : null;
  const native = snapshot.system?.macOS;
  const nativeFresh = native && now >= native.sampledAt && now - native.sampledAt <= 20_000;
  return { savedAt: now, sampledAt: snapshot.sampledAt, kind: 'snapshot', state: held ? 'held' : 'observed', phase: snapshot.phase,
    measurements: {
      generation: current?.liveDecodeTPS ?? null, recentOutput,
      prefillRemaining: current?.prefillProgress == null ? null : (1 - current.prefillProgress) * 100,
      processed: current?.prefillProcessedTokens ?? null, total: current?.prefillTotalTokens ?? null,
      stageEstimate: !held && !current?.prefillProgressStale ? current?.prefillETASeconds ?? null : null,
      active: current?.activeRequests ?? null, queued: current?.queuedRequests ?? null,
      cpu: snapshot.system?.cpuPercent ?? null, memory: gib(snapshot.system?.memoryUsedGB),
      footprint: gib(current?.memory?.activeGB), swap: gib(nativeFresh ? native.swapUsedGB : null),
      ...(current?.runtime === 'splash' && current.serverStats ? {
        splashDecode: current.serverStats.aggregateDecodeTokensPerSecond,
        splashCompleted: current.serverStats.completedRequests,
        splashFailed: current.serverStats.failedRequests,
        splashMetalCurrent: gib(current.serverStats.metalCurrentGB),
        splashMetalPeak: gib(current.serverStats.metalPeakGB),
      } : {}),
    } };
};
