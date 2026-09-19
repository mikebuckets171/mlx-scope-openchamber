import type { AvailableTelemetry, TelemetrySnapshot } from '../src/telemetry.ts';

export const SIGNAL_WINDOW_MS = 90_000;
export type SignalPoint = { at: number; rate: number; phase: 'decode' | 'prefill'; segment: number; basis?: 'observed' };

export class SignalHistory {
  points: SignalPoint[] = [];
  private identity = '';
  private segment = 0;

  break(): void { this.identity = ''; }

  observe(snapshot: TelemetrySnapshot, intervalMs = 500, observedRate: number | null = null): void {
    this.prune(snapshot.sampledAt);
    const observed = snapshot.phase === 'decode' && snapshot.liveDecodeTPS === null && observedRate !== null;
    const rate = snapshot.phase === 'decode' ? snapshot.liveDecodeTPS ?? observedRate
      : snapshot.phase === 'prefill' ? snapshot.livePrefillTPS : null;
    if (!snapshot.available || rate === null || !Number.isFinite(rate) || rate < 0) {
      this.identity = '';
      return;
    }
    if (snapshot.phase !== 'decode' && snapshot.phase !== 'prefill') return;
    const identity = JSON.stringify([snapshot.modelID, snapshot.phase, snapshot.traceEpoch, observed]);
    const last = this.points.at(-1);
    if (last && snapshot.sampledAt <= last.at) return;
    const allowedGap = Number.isFinite(intervalMs) ? Math.max(2_500, Math.min(5_000, intervalMs + 1_000)) : 2_500;
    if (identity !== this.identity || !last || snapshot.sampledAt - last.at > allowedGap) this.segment += 1;
    this.identity = identity;
    this.points.push({ at: snapshot.sampledAt, rate, phase: snapshot.phase, segment: this.segment, ...(observed ? {basis: 'observed' as const} : {}) });
    // At the maximum two observations/second this retains a full 90s window.
    if (this.points.length > 200) this.points.splice(0, this.points.length - 200);
  }

  prune(now: number): void { this.points = this.points.filter((point) => point.at >= now - SIGNAL_WINDOW_MS); }
}

export const nextDelay = (snapshot: AvailableTelemetry | null, failures: number): number => {
  if (failures > 0) return Math.min(15_000, 1_000 * 2 ** Math.min(4, failures - 1));
  return snapshot && ['decode', 'prefill', 'processing', 'queued'].includes(snapshot.phase) ? 500 : 2_000;
};

/** Fixed time domain and zero baseline; small variations are not exaggerated. */
export const traceGeometry = (points: SignalPoint[], now: number, width = 600, height = 120) => {
  const visible = points.filter((point) => point.at >= now - SIGNAL_WINDOW_MS && point.at <= now);
  const peak = Math.max(0, ...visible.map((point) => point.rate));
  const magnitude = peak > 0 ? 10 ** Math.floor(Math.log10(peak)) : 1;
  const upper = Math.max(10, ([1, 2, 5, 10, 20].find((step) => step * magnitude >= peak * 1.1) ?? 20) * magnitude);
  const x = (at: number) => 4 + (at - (now - SIGNAL_WINDOW_MS)) / SIGNAL_WINDOW_MS * (width - 8);
  const y = (rate: number) => height - 4 - rate / upper * (height - 8);
  const segments: SignalPoint[][] = [];
  for (const point of visible) {
    if (segments.at(-1)?.at(-1)?.segment === point.segment) segments.at(-1)!.push(point);
    else segments.push([point]);
  }
  return {
    upper, peak,
    paths: segments.map((segment) => segment.map((point, index) => `${index ? 'L' : 'M'}${x(point.at).toFixed(2)},${y(point.rate).toFixed(2)}`).join(' ')),
    latest: visible.length ? { x: x(visible.at(-1)!.at), y: y(visible.at(-1)!.rate) } : null,
  };
};
