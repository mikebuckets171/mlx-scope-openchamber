import { contextBudget } from '../context.ts';
import { prefillEstimate, type RecentSpeed } from '../insights.ts';
import { prefillReading } from '../progress.ts';
import { age, count, decimalText, EMPTY, finishedAgo, gibNumber, gibText, looseRate, oneDecimalText, percent, ratio, seconds } from './format.ts';
import type { HostReading, Reading } from './reading.ts';
import type { Scope } from './scope.ts';

/** The Live tab's hero, request metrics and host card. */
export interface LiveView {
  estimateSource: string; recentSpeedHidden: boolean; signalHidden: boolean;
  rate: string; rateIsWord: boolean; unit: string; activity: string; activityHidden: boolean;
  requestOutput: string; requestOutputHidden: boolean;
  headroom: { remaining: string; accounted: string; percent: number | null } | null;
  metrics: {
    contextHidden: boolean; context: string; contextDetail: string; contextBar: number | null;
    reuseHidden: boolean; reuse: string; reuseDetail: string; reuseBar: number | null;
    requests: string; queue: string; output: string; elapsed: string;
  };
  host: HostView;
}
export interface HostView {
  hidden: boolean; stale: boolean; resourceState: string;
  card: { title: string; hardware: string; freshness: string; cpu: string; cpuBar: number | null; ram: string; ramBar: number | null;
    macHidden: boolean; wired: string; compressed: string; swap: string; nativeFreshness: string } | null;
}
export type ProgressHold = false | 'paused' | 'refreshing';
export interface ProgressView {
  remaining: string; completed: string; state: string; held: boolean; percent: number | null; valueNow: string | null; valueText: string; counts: string;
}

const hero = (s: Scope) => {
  const { runtime, stale, phase, splashRate, liveRate, logRate, logActivity, logRequest, observed } = s;
  const lastRate = logRequest?.decodeTps ?? null;
  if (runtime === 'splash') return {
    rate: s.splashLoading ? 'Loading' : splashRate !== null ? oneDecimalText(splashRate) : stale ? EMPTY : 'Ready',
    rateIsWord: splashRate === null,
    unit: s.splashLoading ? 'Splash is loading the model'
      : stale ? splashRate !== null ? 'tok/s · last reading, not live' : 'Waiting for Splash'
        : splashRate === null ? 'Speed appears after the first request' : 'tok/s · server decode, all requests',
  };
  return {
    rate: liveRate !== null ? oneDecimalText(liveRate) : logRate !== null ? oneDecimalText(logRate)
      : logActivity && phase === 'decode' ? 'Generating' : logActivity && phase === 'prefill' ? 'Reading'
        : phase === 'idle' ? 'Ready' : phase === 'notLoaded' ? 'Standby' : EMPTY,
    rateIsWord: liveRate === null && logRate === null,
    unit: liveRate !== null ? observed ? 'tokens / second · recent output' : phase === 'prefill' ? 'prefill tokens / second' : 'tokens / second · request average'
      : logActivity && phase === 'decode' ? `Exact speed when it finishes${lastRate !== null ? ` · last ${oneDecimalText(lastRate)} tok/s` : ''}`
        : logActivity && phase === 'prefill' ? 'Reading the prompt'
          : logRate !== null ? `tok/s · last response (exact)${logRequest ? ` · ${finishedAgo(logRequest.finishedAt, s.now)}` : ''}`
            : phase === 'idle' ? 'Waiting for your next request' : phase === 'notLoaded' ? `Load a model in ${s.name}` : 'No fresh throughput',
  };
};

const activity = (s: Scope): string => {
  const { current, phase, name } = s;
  if (s.splashEngine && s.runtime === 'lmstudio' && phase === 'notLoaded') return 'Load a Splash model in Bionic to start. Activity appears here as soon as it serves a request.';
  if (!current) return s.reading.message ?? `Start ${name} on this host, then refresh.`;
  return current.message ?? (phase === 'idle' ? 'Model loaded. Ready for your next request.' : phase === 'notLoaded' ? `${name} is running. Load a model to begin.`
    : `${count(current.active)} active · ${current.queued === null ? 'queue not reported' : current.queued ? `${current.queued} queued` : 'queue clear'}`);
};

const metrics = (s: Scope): LiveView['metrics'] => {
  const { current, display, coverage, runtime } = s, request = current?.request, last = s.logRequest;
  // Runtimes without live token counts fall back to the last finished response's exact figures.
  const source = request?.promptTokens != null ? { prompt: request.promptTokens, cached: request.cachedTokens ?? null, basis: '' }
    : last?.promptTokens != null ? { prompt: last.promptTokens, cached: last.cachedTokens ?? null, basis: ' · last response' } : null;
  const limit = current?.contextWindowTokens ?? current?.catalog.find(model => model.loaded && model.name === display?.model)?.contextWindowTokens
    ?? current?.catalog.find(model => model.loaded)?.contextWindowTokens ?? null;
  const contextPercent = ratio(source?.prompt, limit), reusedPercent = ratio(source?.cached, source?.prompt);
  const omlxRequests = coverage === 'requests' && runtime === 'omlx';
  return {
    contextHidden: contextPercent === null && !(request?.promptTokens == null && omlxRequests),
    context: percent(contextPercent), contextDetail: source === null ? 'Not reported' : `${count(source.prompt)} / ${count(limit)}${source.basis}`, contextBar: contextPercent,
    reuseHidden: reusedPercent === null && !(request?.cachedTokens == null && omlxRequests),
    reuse: percent(reusedPercent), reuseDetail: source?.cached == null ? 'Not reported' : `${count(source.cached)} tokens${source.basis}`, reuseBar: reusedPercent,
    requests: count(current?.active),
    queue: current ? current.queued === null ? current.active ? 'running now' : 'none running' : current.queued ? `${current.queued} queued` : 'Queue clear' : 'No live reading',
    output: count(request?.outputTokens), elapsed: seconds(request?.elapsedMs),
  };
};

/** The host card. Its values keep their last reading while the host sampler is silent; only live ones are fresh. */
export const presentHost = (fresh: HostReading | null, retained: HostReading | null, now: number): HostView => {
  const system = fresh ?? retained, mac = system?.mac ?? null;
  const nativeFresh = fresh !== null && mac !== null && now - mac.sampledAt <= 20_000;
  return {
    hidden: system === null, stale: fresh === null, resourceState: fresh ? 'Whole-host observations' : 'Recent observations · not live',
    card: system && {
      title: system.platform === 'macOS' ? 'macOS host' : `${system.platform} resources`,
      hardware: [system.cpuModel, system.logicalCores ? `${system.logicalCores} logical cores` : null].filter(Boolean).join(' · '),
      freshness: fresh ? age(system.sampledAt, now) : 'Last reading · not live',
      cpu: percent(fresh?.cpuPercent), cpuBar: fresh?.cpuPercent ?? null,
      ram: `${gibNumber(system.memUsedBytes)} / ${gibText(system.memTotalBytes)}`, ramBar: ratio(system.memUsedBytes, system.memTotalBytes),
      macHidden: system.platform !== 'macOS',
      wired: gibText(nativeFresh ? mac.wiredBytes : null), compressed: gibText(nativeFresh ? mac.compressedBytes : null), swap: gibText(nativeFresh ? mac.swapUsedBytes : null),
      nativeFreshness: mac ? `${age(mac.sampledAt, now)} · native readings up to every 10s` : 'Native diagnostics unavailable on this host',
    },
  };
};

export const presentLive = (s: Scope): LiveView => {
  const { current, logActivity } = s, request = current?.request;
  const liveCounts = request?.decodeTps != null || request?.prefillTps != null || request?.outputTokens != null;
  const hasOutput = current !== null && ['decode', 'processing'].includes(current.phase) && request?.outputTokens != null;
  const genericActivity = current !== null && !current.message && !['idle', 'notLoaded'].includes(s.phase);
  const budget = contextBudget(s.reading);
  return {
    estimateSource: `${s.name} estimate · may change`,
    recentSpeedHidden: logActivity && !liveCounts || current?.phase !== 'decode' || request?.decodeTps == null && s.observed !== null,
    // Without live token counts there is nothing to chart.
    signalHidden: logActivity && !liveCounts,
    ...hero(s), activity: activity(s),
    // The heading and phase already say "Generating"; only runtime messages, idle guidance and concurrency add information.
    activityHidden: logActivity && s.phase === 'decode' && (current?.active ?? 0) <= 1 || s.splashLoading || genericActivity,
    requestOutputHidden: !hasOutput,
    requestOutput: hasOutput ? `${request!.outputTokens!.toLocaleString()} output tokens${request!.elapsedMs != null ? ` · ${decimalText(request!.elapsedMs / 1000)}s elapsed` : ''}` : '',
    headroom: budget && { remaining: `${count(budget.remaining)} tokens to model limit`, accounted: `${percent(budget.percent)} accounted · prompt + output`, percent: budget.percent },
    metrics: metrics(s),
    host: presentHost(s.reading.host, s.host, s.now),
  };
};

/** Prefill progress for the current stage, or null outside prefill. `held` marks a frozen or refreshing reading. */
export const presentProgress = (reading: Reading | null, held: ProgressHold = false): ProgressView | null => {
  const progress = prefillReading(reading);
  if (!progress) return null;
  const stale = Boolean(held) || progress.stale;
  return {
    remaining: progress.remaining, completed: progress.completed, held: stale, percent: progress.percent,
    state: held ? held === 'paused' ? 'Paused · last reading' : 'Refreshing · last reading' : progress.stale ? 'Waiting for progress' : progress.percent === null ? 'Not reported' : 'Live reading',
    valueNow: progress.percent === null ? null : String(Math.floor(progress.percent)),
    valueText: progress.percent === null ? 'Progress not reported' : `${progress.remaining}; ${progress.completed}${stale ? '; last reading, not live' : ''}`,
    counts: progress.counts ? `${progress.counts.done.toLocaleString()} / ${progress.counts.total.toLocaleString()} tokens processed · ${progress.counts.remaining.toLocaleString()} left`
      : 'Percent of the current prefill stage, not time remaining.',
  };
};

/** The runtime's own stage estimate and the observed recent speed, beside the hero. */
export const presentRecent = (reading: Reading, speed: RecentSpeed | null) => {
  const current = reading.available ? reading : null, estimate = prefillEstimate(current);
  const observed = current?.phase === 'decode' ? speed : null;
  return {
    estimateHidden: estimate === null, estimate: estimate ?? EMPTY,
    windowSpeed: observed ? looseRate(observed.tokensPerSecond) : 'Gathering samples…',
    windowSpan: observed ? `Observed over ${decimalText(observed.seconds)}s` : 'Recent speed · needs 2s of observations',
  };
};
