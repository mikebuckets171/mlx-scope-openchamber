import { gib } from './present/format.ts';
import type { LegacyReading as Reading } from './compat/reading.ts';

export const MAX_RECENT_GENERATIONS = 8;
export const RECENT_WINDOW_MS = 10_000;
const GAP_MS = 12_000;
export type GenerationObservation = {
  sequence: number; model: string; epoch: number; firstSeenAt: number; lastSeenAt: number;
  outputTokens: number | null; averageTPS: number | null; elapsedMs: number | null;
  promptTokens: number | null; cachedTokens: number | null; peakProcessBytes: number | null;
  coverage: 'no-longer-observed' | 'monitoring-gap';
};
type Sample = { at: number; tokens: number };
export type RecentSpeed = { tokensPerSecond: number; seconds: number };
const safe = (value: number | null | undefined): number | null => value != null && Number.isFinite(value) && value >= 0 ? value : null;

/** Observation history, not a completion log. No storage, timers, or additional requests. */
export class SessionInsights {
  readonly recent: GenerationObservation[] = [];
  speed: RecentSpeed | null = null;
  private active: GenerationObservation | null = null;
  private samples: Sample[] = [];
  private lastAt = -Infinity;
  private sequence = 0;
  private lastTokens: number | null = null;
  private lastElapsed: number | null = null;

  observe(reading: Reading): void {
    if (!reading.available) { this.break(); return; }
    const time = reading.sampledAt;
    if (!Number.isFinite(time) || Math.abs(time) > 8.64e15) { this.break(); return; }
    if (time === this.lastAt) return; // cached snapshots and view-only rerenders
    if (time < this.lastAt || time - this.lastAt > GAP_MS) this.break();
    this.lastAt = time;
    const request = reading.request, tokens = safe(request?.outputTokens), elapsed = safe(request?.elapsedMs);
    const isGeneration = (reading.phase === 'decode' || reading.phase === 'processing')
      && tokens !== null && tokens > 0 && reading.model !== null && reading.traceEpoch !== null
      && (reading.active ?? 0) <= 1;
    if (!isGeneration) { this.finish('no-longer-observed'); return; }
    const same = this.active && this.active.model === reading.model && this.active.epoch === reading.traceEpoch;
    const reset = same && (this.lastTokens !== null && tokens! < this.lastTokens
      || this.lastElapsed !== null && elapsed !== null && elapsed < this.lastElapsed);
    if (!same || reset) {
      this.finish(reset ? 'monitoring-gap' : 'no-longer-observed');
      this.active = { sequence: ++this.sequence, model: reading.model!, epoch: reading.traceEpoch!,
        firstSeenAt: time, lastSeenAt: time, outputTokens: null, averageTPS: null, elapsedMs: null,
        promptTokens: null, cachedTokens: null, peakProcessBytes: null, coverage: 'no-longer-observed' };
    }
    const active = this.active!;
    active.lastSeenAt = time; active.outputTokens = tokens; active.elapsedMs = elapsed;
    active.promptTokens = safe(request?.promptTokens); active.cachedTokens = safe(request?.cachedTokens);
    const process = safe(reading.memory.processBytes);
    if (process !== null) active.peakProcessBytes = Math.max(active.peakProcessBytes ?? 0, process);
    this.lastTokens = tokens; this.lastElapsed = elapsed;
    if (reading.phase !== 'decode') { this.samples = []; this.speed = null; return; }
    active.averageTPS = safe(request?.decodeTps);
    this.samples.push({ at: time, tokens: tokens! });
    this.samples = this.samples.filter(sample => time - sample.at <= RECENT_WINDOW_MS).slice(-24);
    const first = this.samples[0]!;
    const seconds = (time - first.at) / 1000;
    this.speed = this.samples.length >= 3 && seconds >= 2 && tokens! >= first.tokens
      ? { tokensPerSecond: (tokens! - first.tokens) / seconds, seconds } : null;
  }

  private finish(coverage: GenerationObservation['coverage']): void {
    if (this.active) {
      this.active.coverage = coverage;
      this.recent.unshift(this.active);
      this.recent.splice(MAX_RECENT_GENERATIONS);
    }
    this.active = null; this.samples = []; this.speed = null; this.lastTokens = null; this.lastElapsed = null;
  }
  break(): void { this.finish('monitoring-gap'); this.lastAt = -Infinity; }
  clear(): void { this.active = null; this.recent.length = 0; this.samples = []; this.speed = null; this.lastAt = -Infinity; this.lastTokens = null; this.lastElapsed = null; }
}

/** Runtime estimate only, updated with samples; never a ticking countdown or a completion promise. */
export const prefillEstimate = (reading: Reading | null): string | null => {
  const request = reading?.request, progress = request?.prefillFraction ?? null;
  if (!reading || reading.phase !== 'prefill' || request?.prefillStale === true || progress === null
    || progress >= 1 || (request?.prefillTps ?? 0) <= 0) return null;
  const eta = safe(request?.prefillEtaMs);
  if (eta === null) return null;
  const seconds = eta / 1000;
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `~${Math.ceil(seconds / 5) * 5}s`;
  if (seconds < 3600) return `~${Math.ceil(seconds / 60)}m`;
  if (seconds < 86400) return `~${(seconds / 3600).toFixed(1)}h`;
  return '>24h';
};

/** Reused against new input for one request; null unless both counts are reported and consistent. */
export const cacheSplit = (total: number | null | undefined, reused: number | null | undefined) => {
  if (total == null || reused == null || !Number.isSafeInteger(total) || !Number.isSafeInteger(reused)
    || total <= 0 || reused < 0 || reused > total) return null;
  return { total, reused, fresh: total - reused, percent: reused / total * 100 };
};

/** Report excludes model names, epochs, raw errors, prompts, and request IDs. */
export const recentGenerationsReport = (records: readonly GenerationObservation[], version: string): string => {
  const value = (n: number | null) => n === null ? 'not reported' : String(Number(n.toFixed(2)));
  return [`MLX Scope ${version} — recent generation observations`,
    'Server-wide observations made while this view was open. Not a completion log; counts are last seen, not final.',
    ...records.slice(0, MAX_RECENT_GENERATIONS).map((r, index) => `${index + 1}. ${new Date(r.lastSeenAt).toISOString()} | ${r.coverage === 'monitoring-gap' ? 'monitoring gap' : 'no longer observed'} | last seen average ${value(r.averageTPS)} tok/s | last seen output ${value(r.outputTokens)} | reported elapsed ${value(r.elapsedMs === null ? null : r.elapsedMs / 1000)}s | input ${value(r.promptTokens)} | reused ${value(r.cachedTokens)} | peak observed process ${value(gib(r.peakProcessBytes))} GiB`)].join('\n');
};
