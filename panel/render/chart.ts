import { ENGINE_SPEED } from '../present/scope.ts';
import { tps } from '../present/format.ts';
import { SIGNAL_WINDOW_MS, type SignalPoint } from '../signal.ts';

// The Live hero's 90 s chart (G2): the panel's own readings, one point per poll, drawn only where readings exist. A break
// in the line is a gap, never a zero, and the chart appears only after 2 readings.

export interface ChartView { title: string; ceiling: string; label: string; line: string; area: string; mark: number | null; points: number }
/** A round ceiling a little above the peak, in steps of 5, never below 20 tok/s (the mock's scale). */
export const niceCeil = (value: number): number => Math.ceil(Math.max(20, value) * 1.05 / 5) * 5;
const W = 600, H = 120, x = (at: number, now: number): number => 4 + (1 - (now - at) / SIGNAL_WINDOW_MS) * (W - 8);

export const liveChart = (samples: readonly SignalPoint[], now: number, turnStartAt: number | null, scope: 'request' | 'server' = 'request'): ChartView | null => {
  const points = samples.filter(point => point.phase === 'decode' && point.basis === (scope === 'server' ? 'derived' : undefined) && point.at >= now - SIGNAL_WINDOW_MS && point.at <= now);
  if (points.length < 2) return null;
  const peak = Math.max(...points.map(point => point.rate)), ceiling = niceCeil(peak);
  const y = (rate: number): number => H - 4 - rate / ceiling * (H - 8);
  const segments: SignalPoint[][] = [];
  for (const point of points) {
    if (segments.at(-1)?.at(-1)?.segment === point.segment) segments.at(-1)!.push(point);
    else segments.push([point]);
  }
  const path = (segment: SignalPoint[]): string => segment.map((point, index) => `${index ? 'L' : 'M'}${x(point.at, now).toFixed(1)} ${y(point.rate).toFixed(1)}`).join(' ');
  const base = (H - 4).toFixed(1);
  const low = Math.min(...points.map(point => point.rate)), latest = points.at(-1)!.rate, title = scope === 'server' ? `${ENGINE_SPEED} · server-wide · derived` : 'Decode · request average';
  return {
    title, ceiling: `${ceiling} tok/s`, points: points.length,
    label: `${title}, last ${Math.round((now - points[0]!.at) / 1_000)} s: ${tps(low)} to ${tps(peak)} tokens per second, now ${tps(latest)}`,
    line: segments.map(path).join(' '),
    area: segments.filter(segment => segment.length > 1)
      .map(segment => `${path(segment)} L${x(segment.at(-1)!.at, now).toFixed(1)} ${base} L${x(segment[0]!.at, now).toFixed(1)} ${base}Z`).join(' '),
    mark: scope === 'request' && turnStartAt !== null && now - turnStartAt < SIGNAL_WINDOW_MS && turnStartAt <= now ? Number(x(turnStartAt, now).toFixed(1)) : null,
  };
};
