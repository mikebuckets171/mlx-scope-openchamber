import type { AvailableTelemetry, TelemetrySnapshot } from '../src/telemetry.ts';

export const MAX_RECENT_GENERATIONS = 8;
export const RECENT_WINDOW_MS = 10_000;
const GAP_MS = 12_000;
export type GenerationObservation = {
  sequence: number; model: string; epoch: number; firstSeenAt: number; lastSeenAt: number;
  outputTokens: number | null; averageTPS: number | null; elapsedSeconds: number | null;
  promptTokens: number | null; cachedTokens: number | null; peakProcessGB: number | null;
  coverage: 'no-longer-observed' | 'monitoring-gap';
};
type Sample = { at: number; tokens: number };
export type RecentSpeed = { tokensPerSecond: number; seconds: number };
const safe = (value: number | null): number | null => value !== null && Number.isFinite(value) && value >= 0 ? value : null;

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

  observe(snapshot: TelemetrySnapshot): void {
    if (!snapshot.available) { this.break(); return; }
    const time = snapshot.sampledAt;
    if (!Number.isFinite(time) || Math.abs(time) > 8.64e15) { this.break(); return; }
    if (time === this.lastAt) return; // cached snapshots and view-only rerenders
    if (time < this.lastAt || time - this.lastAt > GAP_MS) this.break();
    this.lastAt = time;
    const tokens = safe(snapshot.completionTokens), elapsed = safe(snapshot.elapsedSeconds);
    const isGeneration = (snapshot.phase === 'decode' || snapshot.phase === 'processing')
      && tokens !== null && tokens > 0 && snapshot.modelID !== null && snapshot.traceEpoch !== null
      && (snapshot.activeRequests ?? 0) <= 1;
    if (!isGeneration) { this.finish('no-longer-observed'); return; }
    const same = this.active && this.active.model === snapshot.modelID && this.active.epoch === snapshot.traceEpoch;
    const reset = same && (this.lastTokens !== null && tokens! < this.lastTokens
      || this.lastElapsed !== null && elapsed !== null && elapsed < this.lastElapsed);
    if (!same || reset) {
      this.finish(reset ? 'monitoring-gap' : 'no-longer-observed');
      this.active = { sequence: ++this.sequence, model: snapshot.modelID!, epoch: snapshot.traceEpoch!,
        firstSeenAt: time, lastSeenAt: time, outputTokens: null, averageTPS: null, elapsedSeconds: null,
        promptTokens: null, cachedTokens: null, peakProcessGB: null, coverage: 'no-longer-observed' };
    }
    const active = this.active!;
    active.lastSeenAt = time; active.outputTokens = tokens; active.elapsedSeconds = elapsed;
    active.promptTokens = safe(snapshot.promptTokens); active.cachedTokens = safe(snapshot.cachedTokens);
    const process = snapshot.memory?.activeGB ?? null;
    if (safe(process) !== null) active.peakProcessGB = Math.max(active.peakProcessGB ?? 0, process!);
    this.lastTokens = tokens; this.lastElapsed = elapsed;
    if (snapshot.phase !== 'decode') { this.samples = []; this.speed = null; return; }
    active.averageTPS = safe(snapshot.liveDecodeTPS);
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

/** Report excludes model names, epochs, raw errors, prompts, and request IDs. */
export const recentGenerationsReport = (records: readonly GenerationObservation[], version: string): string => {
  const value = (n: number | null) => n === null ? 'not reported' : String(Number(n.toFixed(2)));
  return [`MLX Scope ${version} — recent generation observations`,
    'Server-wide observations made while this view was open. Not a completion log; counts are last seen, not final.',
    ...records.slice(0, MAX_RECENT_GENERATIONS).map((r, index) => `${index + 1}. ${new Date(r.lastSeenAt).toISOString()} | ${r.coverage === 'monitoring-gap' ? 'monitoring gap' : 'no longer observed'} | last seen average ${value(r.averageTPS)} tok/s | last seen output ${value(r.outputTokens)} | reported elapsed ${value(r.elapsedSeconds)}s | input ${value(r.promptTokens)} | reused ${value(r.cachedTokens)} | peak observed process ${value(r.peakProcessGB === null ? null : r.peakProcessGB * 1e9 / 1024 ** 3)} GiB`)].join('\n');
};
