import type { TelemetrySnapshot } from '../src/telemetry.ts';

export type Capture = {
  model: string; targetSeconds: 30 | 60; startedAt: number; lastAt: number;
  seconds: number; samples: number; decodeSeconds: number; decodeTokens: number;
  peakProcessGB: number | null; processSamples: number;
  meanCPU: number | null; peakCPU: number | null; cpuSamples: number;
  meanMemoryGB: number | null; peakMemoryGB: number | null; memorySamples: number;
  requestCountChange: number | null; startSwapGB: number | null;
  lastSwapGB: number | null; status: 'recording' | 'finished' | 'interrupted'; note: string;
};
type Counter = { epoch: number; tokens: number; at: number };
const count = (n: number | null): n is number => n !== null && Number.isSafeInteger(n) && n >= 0;
const safe = (n: number | null | undefined): n is number => n != null && Number.isFinite(n) && n >= 0;
export const capturedRate = (capture: Capture | null): number | null => capture && capture.decodeSeconds >= 2 ? capture.decodeTokens / capture.decodeSeconds : null;

/** Explicit, bounded observation window. Two summaries + one counter, not a request log.
 * Uses the monitor's existing observations; no timer, inference, disk write or network call.
 */
export class PerformanceCapture {
  current: Capture | null = null;
  baseline: Capture | null = null;
  private previous: Counter | null = null;
  private started = 0;
  private lastClock = 0;
  private lastRuntimeAt: number | null = null;
  private lastSystemAt: number | null = null;
  private lastMacAt: number | null = null;
  private initialRequests: number | null = null;
  private previousRequests: number | null = null;
  private previousUptime: number | null = null;
  private requestCounterValid = false;
  private resourcesOnly = false;
  constructor(private readonly clock: () => number = () => performance.now()) {}
  get recording(): boolean { return this.current?.status === 'recording'; }

  start(snapshot: TelemetrySnapshot, targetSeconds: 30 | 60): boolean {
    const resourcesOnly = ['inventory', 'server'].includes(snapshot.connection?.coverage ?? '') && snapshot.system !== null;
    if (this.recording || !snapshot.available || !resourcesOnly && (!snapshot.modelID || snapshot.activeRequests !== 1
      || !['decode', 'prefill', 'processing'].includes(snapshot.phase))) return false;
    this.resourcesOnly = resourcesOnly;
    this.started = this.lastClock = this.clock();
    this.current = { model: resourcesOnly ? `resources:${snapshot.connection?.selected ?? snapshot.runtime}` : snapshot.modelID!, targetSeconds, startedAt: snapshot.sampledAt,
      lastAt: snapshot.sampledAt, seconds: 0, samples: 0, decodeSeconds: 0, decodeTokens: 0,
      peakProcessGB: null, processSamples: 0, meanCPU: null, peakCPU: null, cpuSamples: 0,
      meanMemoryGB: null, peakMemoryGB: null, memorySamples: 0,
      requestCountChange: null, startSwapGB: null, lastSwapGB: null,
      status: 'recording', note: resourcesOnly ? 'Observing host resources. This runtime does not report passive output speed.' : 'Observing this model. No extra inference is started.' };
    this.previous = null;
    this.lastRuntimeAt = this.lastSystemAt = this.lastMacAt = null;
    this.initialRequests = this.previousRequests = this.previousUptime = null;
    this.requestCounterValid = true;
    this.observe(snapshot);
    // The latest reading can predate the click. Begin rate intervals with the
    // first fresh post-click sample instead of attributing that earlier span.
    this.previous = null;
    return true;
  }
  observe(snapshot: TelemetrySnapshot): void {
    const c = this.current;
    if (!c || !this.recording) return;
    const now = this.clock();
    if (now < this.lastClock || now - this.lastClock > 12_000) { this.stop('Monitoring gap'); return; }
    this.lastClock = now;
    // A late response cannot supply the unobserved end of the requested window.
    if (now - this.started > c.targetSeconds * 1000) { this.finish(); return; }
    if (!snapshot.available) { this.stop('Runtime unavailable'); return; }
    if (this.resourcesOnly ? !['inventory', 'server'].includes(snapshot.connection?.coverage ?? '') || `resources:${snapshot.connection?.selected ?? snapshot.runtime}` !== c.model
      : snapshot.modelID !== c.model || (snapshot.activeRequests ?? 0) > 1) { this.stop('Model, connection or workload changed'); return; }
    if (this.lastRuntimeAt !== null && snapshot.sampledAt < this.lastRuntimeAt) { this.stop('Observation clock changed'); return; }
    const systemFresh = this.observeSystem(snapshot, c);
    if (systemFresh) c.seconds = Math.max(c.seconds, (now - this.started) / 1000);
    if (snapshot.sampledAt === this.lastRuntimeAt) {
      if (now - this.started >= c.targetSeconds * 1000) this.finish();
      return;
    }
    if (this.lastRuntimeAt !== null && snapshot.sampledAt - this.lastRuntimeAt > 12_000) { this.stop('Monitoring gap'); return; }
    c.seconds = Math.max(0, (now - this.started) / 1000);
    this.lastRuntimeAt = snapshot.sampledAt;
    c.lastAt = Math.max(c.lastAt, snapshot.sampledAt); c.samples = Math.min(1000, c.samples + 1);
    if (safe(snapshot.memory?.activeGB)) {
      c.peakProcessGB = Math.max(c.peakProcessGB ?? 0, snapshot.memory.activeGB);
      c.processSamples += 1;
    }
    this.observeRequests(snapshot, c);
    const n = snapshot.completionTokens;
    if (!this.resourcesOnly && snapshot.phase === 'decode' && snapshot.activeRequests === 1 && count(n) && snapshot.traceEpoch !== null) {
      const p = this.previous;
      if (p && p.epoch === snapshot.traceEpoch && n >= p.tokens && snapshot.sampledAt > p.at) {
        const elapsed = (snapshot.sampledAt - p.at) / 1000;
        if (elapsed <= 12) {
          const sum = c.decodeTokens + (n - p.tokens);
          if (!Number.isSafeInteger(sum)) { this.stop('Token counter exceeded safe range'); return; }
          c.decodeTokens = sum; c.decodeSeconds += elapsed;
        }
      }
      this.previous = { epoch: snapshot.traceEpoch, tokens: n, at: snapshot.sampledAt };
    } else this.previous = null;
    if (c.seconds >= c.targetSeconds || c.samples >= 1000) {
      this.finish();
    }
  }
  private observeSystem(snapshot: TelemetrySnapshot, c: Capture): boolean {
    const system = snapshot.system;
    let fresh = false;
    if (system && system.sampledAt >= c.startedAt && (this.lastSystemAt === null || system.sampledAt > this.lastSystemAt)) {
      this.lastSystemAt = system.sampledAt;
      c.lastAt = Math.max(c.lastAt, system.sampledAt);
      if (safe(system.cpuPercent)) {
        c.cpuSamples += 1;
        c.meanCPU = c.meanCPU === null ? system.cpuPercent : c.meanCPU + (system.cpuPercent - c.meanCPU) / c.cpuSamples;
        c.peakCPU = Math.max(c.peakCPU ?? 0, system.cpuPercent);
        fresh = true;
      }
      if (safe(system.memoryUsedGB)) {
        c.memorySamples += 1;
        c.meanMemoryGB = c.meanMemoryGB === null ? system.memoryUsedGB : c.meanMemoryGB + (system.memoryUsedGB - c.meanMemoryGB) / c.memorySamples;
        c.peakMemoryGB = Math.max(c.peakMemoryGB ?? 0, system.memoryUsedGB);
        fresh = true;
      }
    }
    const mac = system?.macOS;
    if (mac && mac.sampledAt >= c.startedAt && (this.lastMacAt === null || mac.sampledAt > this.lastMacAt)) {
      this.lastMacAt = mac.sampledAt;
      if (safe(mac.swapUsedGB)) { c.startSwapGB ??= mac.swapUsedGB; c.lastSwapGB = mac.swapUsedGB; }
    }
    return fresh;
  }
  private observeRequests(snapshot: TelemetrySnapshot, c: Capture): void {
    const requests = snapshot.lifetime?.requestsTotal ?? null;
    const uptime = snapshot.lifetime?.uptimeSeconds ?? null;
    if (!this.requestCounterValid) return;
    if (snapshot.sessionStatsState !== 'fresh' || !count(requests)
      || (this.previousRequests !== null && requests < this.previousRequests)
      || (safe(uptime) && this.previousUptime !== null && uptime < this.previousUptime)) {
      this.requestCounterValid = false; c.requestCountChange = null; return;
    }
    if (this.initialRequests !== null) c.requestCountChange = requests - this.initialRequests;
    else this.initialRequests = requests;
    this.previousRequests = requests;
    if (safe(uptime)) this.previousUptime = uptime;
  }
  private finish(): void {
    const c = this.current;
    if (!c || !this.recording) return;
    if (c.seconds === 0) { this.stop('No fresh observations'); return; }
    c.status = 'finished';
    c.note = `${c.targetSeconds}s window ended · ${c.seconds.toFixed(1)}s observed. Not a controlled benchmark.`;
    this.previous = null;
  }
  stop(reason = 'Stopped by you'): void {
    if (!this.current || !this.recording) return;
    this.current.status = 'interrupted'; this.current.note = reason + ' · partial observation'; this.previous = null;
  }
  pin(): boolean {
    if (!this.current || !this.canPin) return false;
    this.baseline = { ...this.current }; return true;
  }
  get canPin(): boolean {
    const c = this.current;
    return c !== null && !this.recording && (capturedRate(c) !== null || c.cpuSamples >= 2
      || c.memorySamples >= 2 || c.processSamples >= 2 || c.requestCountChange !== null);
  }
  clear(): void { this.current = null; this.baseline = null; this.previous = null; }
  comparison(): number | null {
    const current = this.current, baseline = this.baseline;
    const a = capturedRate(current), b = capturedRate(baseline);
    if (!current || !baseline || this.recording || current.startedAt === baseline.startedAt
      || current.model !== baseline.model || current.decodeSeconds < 5 || baseline.decodeSeconds < 5
      || a === null || b === null || b <= 0) return null;
    return (a / b - 1) * 100;
  }
  report(version: string): string {
    const lines = [`MLX Scope ${version} — performance observations`,
      'Server-wide observations, not selected-chat attribution or a controlled benchmark. Speed uses continuous fresh output intervals, including zero-token intervals; idle, processing and prefill are excluded. Resource means use distinct samples, not time weighting. Differences do not establish causality.'];
    const percent = (value: number | null) => value === null ? 'not reported' : value.toFixed(1) + '%';
    const memory = (value: number | null) => value === null ? 'not reported' : (value * 1e9 / 1024 ** 3).toFixed(2) + ' GiB';
    const print = (label: string, c: Capture) => {
      const rate = capturedRate(c);
      lines.push(`${label}: ${c.status}, ${c.seconds.toFixed(1)}s observed in a ${c.targetSeconds}s window, ${c.samples} runtime samples; ${c.note}`,
        `Observed output: ${rate === null ? 'not enough data' : rate.toFixed(1) + ' tok/s'} across ${c.decodeSeconds.toFixed(1)}s; ${c.decodeTokens} observed token increments.`,
        `Sampled host CPU: mean ${percent(c.meanCPU)}, peak ${percent(c.peakCPU)} (${c.cpuSamples} samples).`,
        `Sampled non-free host RAM: mean ${memory(c.meanMemoryGB)}, peak ${memory(c.peakMemoryGB)} (${c.memorySamples} samples).`,
        `Peak sampled runtime footprint: ${memory(c.peakProcessGB)} (${c.processSamples} samples).`,
        `Reported server request count change: ${c.requestCountChange === null ? 'not available for this window' : c.requestCountChange}.`);
    };
    if (this.current) print('Current capture', this.current);
    if (this.baseline) print('Pinned reference', this.baseline);
    return lines.join('\n'); // No model names, session names, IDs, raw messages or paths.
  }
}
