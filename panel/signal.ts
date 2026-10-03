import type { Reading } from './present/reading.ts';
import { liveSplashRate } from './present/scope.ts';

export const SIGNAL_WINDOW_MS = 90_000;
export type SignalPoint = { at: number; rate: number; phase: 'decode' | 'prefill'; segment: number; basis?: 'observed' | 'derived' };

export class SignalHistory {
  points: SignalPoint[] = [];
  private identity = '';
  private segment = 0;

  break(): void { this.identity = ''; }

  observe(reading: Reading, intervalMs = 500, observedRate: number | null = null): void {
    this.prune(reading.sampledAt);
    const decode = reading.request?.decodeTps ?? null;
    const server = decode === null ? liveSplashRate(reading.body) : null;
    const observed = server === null && reading.phase === 'decode' && decode === null && observedRate !== null;
    const phase = server !== null ? 'decode' : reading.phase;
    const rate = server ?? (reading.phase === 'decode' ? decode ?? observedRate
      : reading.phase === 'prefill' ? reading.request?.prefillTps ?? null : null);
    if (!reading.available || rate === null || !Number.isFinite(rate) || rate < 0) {
      this.identity = '';
      return;
    }
    if (phase !== 'decode' && phase !== 'prefill') return;
    const basis = server !== null ? 'derived' as const : observed ? 'observed' as const : undefined;
    const identity = JSON.stringify([reading.model, phase, reading.traceEpoch, basis]);
    const last = this.points.at(-1);
    if (last && reading.sampledAt <= last.at) return;
    const allowedGap = Number.isFinite(intervalMs) ? Math.max(2_500, Math.min(5_000, intervalMs + 1_000)) : 2_500;
    if (identity !== this.identity || !last || reading.sampledAt - last.at > allowedGap) this.segment += 1;
    this.identity = identity;
    this.points.push({ at: reading.sampledAt, rate, phase, segment: this.segment, ...(basis ? { basis } : {}) });
    // At the maximum two observations/second this retains a full 90s window.
    if (this.points.length > 200) this.points.splice(0, this.points.length - 200);
  }

  prune(now: number): void { this.points = this.points.filter((point) => point.at >= now - SIGNAL_WINDOW_MS); }
}

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
  const paths = segments.map((segment) => segment.map((point, index) => `${index ? 'L' : 'M'}${x(point.at).toFixed(2)},${y(point.rate).toFixed(2)}`).join(' '));
  const base = (height - 4).toFixed(2);
  return {
    upper, peak, paths,
    // Each segment closed down to the zero baseline; gaps stay unfilled.
    areas: segments.map((segment, index) => segment.length < 2 ? ''
      : `${paths[index]} L${x(segment.at(-1)!.at).toFixed(2)},${base} L${x(segment[0]!.at).toFixed(2)},${base} Z`),
    latest: visible.length ? { x: x(visible.at(-1)!.at), y: y(visible.at(-1)!.rate) } : null,
  };
};
