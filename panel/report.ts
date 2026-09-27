import type { TelemetrySnapshot } from '../src/telemetry.ts';
import type { SystemSnapshot } from '../src/system.ts';
import { contextBudget } from './context.ts';
import { prefillReading } from './progress.ts';

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
