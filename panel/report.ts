import type { CompletionV2 } from '../src/contract/completion.ts';
import { contextBudget } from './context.ts';
import { freshnessDeadline } from './data/poller.ts';
import { gib, scalar } from './present/format.ts';
import type { HostReading, Reading } from './present/reading.ts';
import { prefillReading } from './progress.ts';
import { ENGINE_SPEED, liveSplashRate } from './present/scope.ts';

/** Copy only an allowlist of measurements. No raw messages, names, paths, keys or IDs. */
export const measurementReport = (reading: Reading, system: HostReading | null, paused: boolean | 'refreshing', version: string,
  now = Date.now(), last: CompletionV2 | null = null): string => {
  const lines = [`MLX Scope ${version} — OpenChamber extension`, 'Scope: runtime server / whole host, not a selected chat',
    `State: ${paused === 'refreshing' ? 'refreshing — held observations' : paused ? 'paused — held observations' : reading.available ? reading.phase : 'unavailable'}`,
    `Sample age: ${scalar(Math.max(0, (now - reading.sampledAt) / 1000), ' seconds')}`];
  if (!reading.available) lines.push(`Connection: ${reading.reason}`);
  if (reading.available) {
    const request = reading.request, eta = request?.prefillEtaMs ?? null;
    const budget = contextBudget(reading);
    if (budget) lines.push(`Model context: ${budget.used} / ${budget.limit}; ${budget.remaining} tokens to reported limit (not OpenCode compaction or output budget)`);
    const progress = prefillReading(reading);
    if (progress) {
      lines.push(`Prefill: ${progress.remaining}${progress.stale || paused ? ' (last reading)' : ''} — current stage only`);
      if (!paused && !progress.stale && eta !== null) lines.push(`Prefill stage estimate: ${scalar(eta / 1000, ' seconds')} (reported stage estimate, not a completion deadline)`);
      if (progress.counts) lines.push(`Prefill tokens: ${progress.counts.done} / ${progress.counts.total}; ${progress.counts.remaining} remaining`);
    }
    // Only measured values are listed; a runtime's unreported fields are simply left out.
    const measured = (label: string, value: number | null | undefined, unit = '') => { if (value != null && Number.isFinite(value)) lines.push(`${label}: ${scalar(value, unit)}`); };
    const ms = (value: number | null | undefined) => value == null ? null : value / 1000;
    measured('Generation (request average)', request?.decodeTps, ' tok/s');
    measured('Prefill (reported speed)', request?.prefillTps, ' tok/s');
    measured('Prompt tokens', request?.promptTokens); measured('Cached tokens', request?.cachedTokens);
    measured('Output tokens', request?.outputTokens); measured('Elapsed', ms(request?.elapsedMs), ' seconds');
    measured('Active requests', reading.active); measured('Queued requests', reading.queued);
    if (last) {
      measured('Last response speed (exact)', last.decodeTps, ' tok/s'); measured('Last response first token', ms(last.ttftMs), ' seconds');
      measured('Last response prompt tokens', last.promptTokens); measured('Last response cached tokens', last.cachedTokens);
      measured('Last response output tokens', last.outputTokens);
    }
    if (reading.runtime === 'splash' && reading.splash) {
      const stats = reading.splash;
      lines.push(`Splash ready: ${stats.ready ? 'yes' : 'no'}`);
      measured('Splash average since engine start (all requests)', stats.decodeTps, ' tok/s');
      measured('Splash prefill average since engine start (all requests)', reading.body?.runtime.server.averages?.prefillTps, ' tok/s');
      const fresh = !paused && now - reading.sampledAt <= freshnessDeadline(reading.body?.nextPollMs ?? 2000);
      const recent = fresh ? liveSplashRate(reading.body) : null;
      if (recent !== null) lines.push(`${ENGINE_SPEED} (server-wide, derived, last ${scalar(reading.body!.runtime.server.rates!.windowMs / 1000)} seconds): ${scalar(recent)} tok/s; output tokens / native decode-command time`);
      const prefill = fresh ? liveSplashRate(reading.body, 'prefill') : null;
      const rates = reading.body?.runtime.server.rates;
      if (prefill !== null) lines.push(`Recent prefill engine speed (server-wide, derived, last ${scalar((rates!.promptWindowMs ?? rates!.windowMs) / 1000)} seconds): ${scalar(prefill)} tok/s; processed input tokens / native prefill-command time`);
      measured('Splash completed requests since start', stats.completed);
      measured('Splash failed requests since start', stats.failed);
      measured('Splash GPU memory (Metal) · now', gib(stats.metalBytes), ' GiB');
      measured('Splash GPU memory (Metal) · peak', gib(stats.metalPeakBytes), ' GiB');
    }
  }
  if (system) {
    lines.push(`Host sample age: ${scalar(Math.max(0, (now - system.sampledAt) / 1000), ' seconds')}`,
      `CPU: ${scalar(system.cpuPercent, '%')}`,
      `Non-free RAM: ${scalar(gib(system.memUsedBytes), ' GiB')} (includes reclaimable pages; not memory pressure)`);
    if (system.mac) lines.push(`Native sample age: ${scalar(Math.max(0, (now - system.mac.sampledAt) / 1000), ' seconds')}`,
      `Swap used: ${scalar(gib(system.mac.swapUsedBytes), ' GiB')}`);
  }
  return lines.join('\n');
};
