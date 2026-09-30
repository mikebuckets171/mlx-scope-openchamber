import type { RuntimeKind } from '../../src/contract/runtime.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';

// Owner: ui-history. The Captures tab's 30/60 s observation window over v2 snapshots (the 1.6 capture.ts core, ported off
// the 2a `compat` bridge). Server-wide: it averages whatever the runtime does, never starts work, and keeps no timer; the
// frame's own polls feed it and monitoring keeps running.

export const WINDOW_LENGTHS_MS = [60_000, 30_000] as const;
export type WindowLengthMs = typeof WINDOW_LENGTHS_MS[number];
/** Longer than this between two readings is a monitoring gap: the window stops as a partial observation. */
export const WINDOW_GAP_MS = 12_000;
const MIN_DECODE_MS = 2_000;

export interface WindowCaptureState {
  status: 'recording' | 'finished' | 'interrupted';
  stopReason: string | null;
  runtime: RuntimeKind | null;
  targetMs: WindowLengthMs;
  startedAt: number;                         // service clock
  endedAt: number;
  samples: number;                           // distinct runtime readings
  decodeTokens: number; decodeMs: number;    // output increments of one decoding request at a time
  completions: number;                       // replies the service saw finish inside the window
  cpuSamples: number; cpuMean: number | null; cpuPeak: number | null;         // fractions
  memSamples: number; memMeanBytes: number | null; memPeakBytes: number | null;
  footprintPeakBytes: number | null;
  swapStartBytes: number | null; swapEndBytes: number | null;
}
export const windowRate = (state: WindowCaptureState | null): number | null =>
  state && state.decodeMs >= MIN_DECODE_MS ? state.decodeTokens / (state.decodeMs / 1000) : null;

const identity = (snapshot: SnapshotV2): string => JSON.stringify([snapshot.service.instance, snapshot.connection.id, snapshot.connection.runtime, snapshot.connection.generation]);
const usable = (snapshot: SnapshotV2): boolean => snapshot.status.state === 'ready' || snapshot.status.state === 'degraded';
const mean = (current: number | null, n: number, value: number): number => current === null ? value : current + (value - current) / n;

export class WindowCapture {
  private state: WindowCaptureState | null = null;
  private connection = '';
  private runtimeAt: number | null = null;
  private hostAt: number | null = null;
  private previous: { tokens: number; elapsedMs: number | null; at: number } | null = null;
  private seen = new Set<number>();
  get current(): WindowCaptureState | null { return this.state; }
  get recording(): boolean { return this.state?.status === 'recording'; }

  /** False while another window records or while the runtime can't be read. */
  start(snapshot: SnapshotV2, targetMs: WindowLengthMs): boolean {
    if (this.recording || !usable(snapshot)) return false;
    const now = snapshot.serverNow;
    this.state = { status: 'recording', stopReason: null, runtime: snapshot.connection.runtime, targetMs, startedAt: now, endedAt: now, samples: 0,
      decodeTokens: 0, decodeMs: 0, completions: 0, cpuSamples: 0, cpuMean: null, cpuPeak: null, memSamples: 0, memMeanBytes: null, memPeakBytes: null,
      footprintPeakBytes: null, swapStartBytes: null, swapEndBytes: null };
    this.connection = identity(snapshot); this.runtimeAt = this.hostAt = null; this.previous = null;
    // Replies already in the ring finished before the click.
    this.seen = new Set(snapshot.completions.items.map(item => item.seq));
    this.observe(snapshot);
    // The reading at the click can predate it; rate intervals begin with the first reading after it.
    this.previous = null;
    return true;
  }
  observe(snapshot: SnapshotV2): void {
    const s = this.state;
    if (!s || s.status !== 'recording') return;
    const now = snapshot.serverNow;
    if (now < s.endedAt || now - s.endedAt > WINDOW_GAP_MS) { this.stop('Monitoring gap'); return; }
    if (identity(snapshot) !== this.connection) { this.stop('The connection or runtime changed'); return; }
    if (!usable(snapshot)) { this.stop('The runtime stopped answering'); return; }
    // A late poll cannot supply the unobserved end of the window.
    const end = Math.min(now, s.startedAt + s.targetMs);
    s.endedAt = end;
    this.host(snapshot, s, end);
    this.runtime(snapshot, s, end);
    for (const item of snapshot.completions.items) {
      if (this.seen.has(item.seq) || item.finishedAt < s.startedAt || item.finishedAt > end) continue;
      this.seen.add(item.seq); s.completions += 1;
    }
    if (now >= s.startedAt + s.targetMs) this.finish();
  }
  stop(reason = 'Stopped by you'): void {
    if (!this.state || this.state.status !== 'recording') return;
    this.state.status = 'interrupted'; this.state.stopReason = reason; this.previous = null;
  }
  clear(): void { if (!this.recording) this.state = null; }

  private finish(): void {
    const s = this.state!;
    if (!s.samples) { this.stop('No fresh readings'); return; }
    s.status = 'finished'; this.previous = null;
  }
  private runtime(snapshot: SnapshotV2, s: WindowCaptureState, end: number): void {
    const at = snapshot.runtime.sampledAt ?? snapshot.serverNow;
    // A reading from before the click (a cached one at the click included) or after the window's end belongs to no part of it.
    if (at === this.runtimeAt || at < s.startedAt || at > end) { if (at > end) this.previous = null; return; }
    this.runtimeAt = at; s.samples += 1;
    const footprint = snapshot.host?.runtimeProcess?.footprintBytes ?? snapshot.runtime.memory.processBytes;
    if (footprint != null) s.footprintPeakBytes = Math.max(s.footprintPeakBytes ?? 0, footprint);
    const request = snapshot.runtime.request, tokens = request?.outputTokens;
    // Increments count only while exactly one request decodes; a new request (fewer tokens or less elapsed time) restarts.
    if (snapshot.runtime.phase !== 'decode' || snapshot.runtime.server.active !== 1 || tokens == null) { this.previous = null; return; }
    const elapsedMs = request!.elapsedMs ?? null, p = this.previous;
    if (p && tokens >= p.tokens && at > p.at && at - p.at <= WINDOW_GAP_MS && (elapsedMs === null || p.elapsedMs === null || elapsedMs >= p.elapsedMs)) {
      s.decodeTokens += tokens - p.tokens; s.decodeMs += at - p.at;
    }
    this.previous = { tokens, elapsedMs, at };
  }
  private host(snapshot: SnapshotV2, s: WindowCaptureState, end: number): void {
    const host = snapshot.host;
    if (!host || host.sampledAt === this.hostAt || host.sampledAt < s.startedAt || host.sampledAt > end) return;
    this.hostAt = host.sampledAt;
    if (host.cpuFraction != null) { s.cpuSamples += 1; s.cpuMean = mean(s.cpuMean, s.cpuSamples, host.cpuFraction); s.cpuPeak = Math.max(s.cpuPeak ?? 0, host.cpuFraction); }
    if (host.memUsedBytes != null) { s.memSamples += 1; s.memMeanBytes = mean(s.memMeanBytes, s.memSamples, host.memUsedBytes); s.memPeakBytes = Math.max(s.memPeakBytes ?? 0, host.memUsedBytes); }
    const swap = host.mac?.swapUsedBytes;
    if (swap != null) { s.swapStartBytes ??= swap; s.swapEndBytes = swap; }
  }
}
