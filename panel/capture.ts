import { gibFixed } from './present/format.ts';
import type { Reading } from './present/reading.ts';

export type Capture = {
  model: string; targetSeconds: 30 | 60; startedAt: number; lastAt: number;
  seconds: number; samples: number; decodeSeconds: number; decodeTokens: number;
  peakProcessBytes: number | null; processSamples: number;
  meanCPU: number | null; peakCPU: number | null; cpuSamples: number;
  meanMemoryBytes: number | null; peakMemoryBytes: number | null; memorySamples: number;
  requestCountChange: number | null; startSwapBytes: number | null;
  lastSwapBytes: number | null; status: 'recording' | 'finished' | 'interrupted'; note: string;
};
type Counter = { epoch: number; tokens: number; at: number };
const count = (n: number | null | undefined): n is number => n != null && Number.isSafeInteger(n) && n >= 0;
const safe = (n: number | null | undefined): n is number => n != null && Number.isFinite(n) && n >= 0;
export const capturedRate = (capture: Capture | null): number | null => capture && capture.decodeSeconds >= 2 ? capture.decodeTokens / capture.decodeSeconds : null;
const RESOURCES = ['inventory', 'server'];
const resourceKey = (reading: Reading): string => `resources:${reading.link?.selected ?? reading.runtime}`;

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

  start(reading: Reading, targetSeconds: 30 | 60): boolean {
    const resourcesOnly = RESOURCES.includes(reading.link?.coverage ?? '') && reading.host !== null;
    if (this.recording || !reading.available || !resourcesOnly && (!reading.model || reading.active !== 1
      || !['decode', 'prefill', 'processing'].includes(reading.phase))) return false;
    this.resourcesOnly = resourcesOnly;
    this.started = this.lastClock = this.clock();
    this.current = { model: resourcesOnly ? resourceKey(reading) : reading.model!, targetSeconds, startedAt: reading.sampledAt,
      lastAt: reading.sampledAt, seconds: 0, samples: 0, decodeSeconds: 0, decodeTokens: 0,
      peakProcessBytes: null, processSamples: 0, meanCPU: null, peakCPU: null, cpuSamples: 0,
      meanMemoryBytes: null, peakMemoryBytes: null, memorySamples: 0,
      requestCountChange: null, startSwapBytes: null, lastSwapBytes: null,
      status: 'recording', note: resourcesOnly ? reading.runtime === 'splash'
        ? 'Observing host resources. Splash reports one decode speed shared across all requests.'
        : 'Observing host resources. This runtime does not report passive output speed.'
        : 'Observing this model. No extra inference is started.' };
    this.previous = null;
    this.lastRuntimeAt = this.lastSystemAt = this.lastMacAt = null;
    this.initialRequests = this.previousRequests = this.previousUptime = null;
    this.requestCounterValid = true;
    this.observe(reading);
    // The latest reading can predate the click. Begin rate intervals with the
    // first fresh post-click sample instead of attributing that earlier span.
    this.previous = null;
    return true;
  }
  observe(reading: Reading): void {
    const c = this.current;
    if (!c || !this.recording) return;
    const now = this.clock();
    if (now < this.lastClock || now - this.lastClock > 12_000) { this.stop('Monitoring gap'); return; }
    this.lastClock = now;
    // A late response cannot supply the unobserved end of the requested window.
    if (now - this.started > c.targetSeconds * 1000) { this.finish(); return; }
    if (!reading.available) { this.stop('Runtime unavailable'); return; }
    if (this.resourcesOnly ? !RESOURCES.includes(reading.link?.coverage ?? '') || resourceKey(reading) !== c.model
      : reading.model !== c.model || (reading.active ?? 0) > 1) { this.stop('Model, connection or workload changed'); return; }
    if (this.lastRuntimeAt !== null && reading.sampledAt < this.lastRuntimeAt) { this.stop('Observation clock changed'); return; }
    const systemFresh = this.observeSystem(reading, c);
    if (systemFresh) c.seconds = Math.max(c.seconds, (now - this.started) / 1000);
    if (reading.sampledAt === this.lastRuntimeAt) {
      if (now - this.started >= c.targetSeconds * 1000) this.finish();
      return;
    }
    if (this.lastRuntimeAt !== null && reading.sampledAt - this.lastRuntimeAt > 12_000) { this.stop('Monitoring gap'); return; }
    c.seconds = Math.max(0, (now - this.started) / 1000);
    this.lastRuntimeAt = reading.sampledAt;
    c.lastAt = Math.max(c.lastAt, reading.sampledAt); c.samples = Math.min(1000, c.samples + 1);
    const footprint = reading.memory.processBytes ?? (reading.runtime === 'splash' ? reading.splash?.metalBytes ?? null : null);
    if (safe(footprint)) {
      c.peakProcessBytes = Math.max(c.peakProcessBytes ?? 0, footprint);
      c.processSamples += 1;
    }
    this.observeRequests(reading, c);
    const n = reading.request?.outputTokens;
    if (!this.resourcesOnly && reading.phase === 'decode' && reading.active === 1 && count(n) && reading.traceEpoch !== null) {
      const p = this.previous;
      if (p && p.epoch === reading.traceEpoch && n >= p.tokens && reading.sampledAt > p.at) {
        const elapsed = (reading.sampledAt - p.at) / 1000;
        if (elapsed <= 12) {
          const sum = c.decodeTokens + (n - p.tokens);
          if (!Number.isSafeInteger(sum)) { this.stop('Token counter exceeded safe range'); return; }
          c.decodeTokens = sum; c.decodeSeconds += elapsed;
        }
      }
      this.previous = { epoch: reading.traceEpoch, tokens: n, at: reading.sampledAt };
    } else this.previous = null;
    if (c.seconds >= c.targetSeconds || c.samples >= 1000) {
      this.finish();
    }
  }
  private observeSystem(reading: Reading, c: Capture): boolean {
    const system = reading.host;
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
      if (safe(system.memUsedBytes)) {
        c.memorySamples += 1;
        c.meanMemoryBytes = c.meanMemoryBytes === null ? system.memUsedBytes : c.meanMemoryBytes + (system.memUsedBytes - c.meanMemoryBytes) / c.memorySamples;
        c.peakMemoryBytes = Math.max(c.peakMemoryBytes ?? 0, system.memUsedBytes);
        fresh = true;
      }
    }
    const mac = system?.mac;
    if (mac && mac.sampledAt >= c.startedAt && (this.lastMacAt === null || mac.sampledAt > this.lastMacAt)) {
      this.lastMacAt = mac.sampledAt;
      if (safe(mac.swapUsedBytes)) { c.startSwapBytes ??= mac.swapUsedBytes; c.lastSwapBytes = mac.swapUsedBytes; }
    }
    return fresh;
  }
  private observeRequests(reading: Reading, c: Capture): void {
    const splash = reading.runtime === 'splash' ? reading.splash : null;
    const splashFinished = splash?.ready && count(splash.completed) && count(splash.failed)
      ? splash.completed + splash.failed : null;
    const requests = reading.lifetime?.requestsTotal ?? splashFinished;
    const uptime = reading.lifetime?.uptimeMs ?? null;
    if (!this.requestCounterValid) return;
    if (reading.statsState !== 'fresh' && splashFinished === null || !count(requests)
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
    const memory = (bytes: number | null) => bytes === null ? 'not reported' : gibFixed(bytes, 2) + ' GiB';
    const print = (label: string, c: Capture) => {
      const rate = capturedRate(c);
      lines.push(`${label}: ${c.status}, ${c.seconds.toFixed(1)}s observed in a ${c.targetSeconds}s window, ${c.samples} runtime samples; ${c.note}`,
        `Observed output: ${rate === null ? 'not enough data' : rate.toFixed(1) + ' tok/s'} across ${c.decodeSeconds.toFixed(1)}s; ${c.decodeTokens} observed token increments.`,
        `Sampled host CPU: mean ${percent(c.meanCPU)}, peak ${percent(c.peakCPU)} (${c.cpuSamples} samples).`,
        `Sampled non-free host RAM: mean ${memory(c.meanMemoryBytes)}, peak ${memory(c.peakMemoryBytes)} (${c.memorySamples} samples).`,
        `Peak sampled runtime footprint: ${memory(c.peakProcessBytes)} (${c.processSamples} samples).`,
        `Reported server request count change: ${c.requestCountChange === null ? 'not available for this window' : c.requestCountChange}.`);
    };
    if (this.current) print('Current capture', this.current);
    if (this.baseline) print('Pinned reference', this.baseline);
    return lines.join('\n'); // No model names, session names, IDs, raw messages or paths.
  }
}
