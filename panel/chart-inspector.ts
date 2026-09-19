import type { SignalPoint } from './signal.ts';

/** Select an actual observation. Never interpolate a speed across a gap. */
export const nearestObservation = (points: readonly SignalPoint[], at: number): SignalPoint | null => {
  if (!Number.isFinite(at)) return null;
  return points.reduce<SignalPoint | null>((best, point) =>
    !best || Math.abs(point.at - at) < Math.abs(best.at - at) ? point : best, null);
};

/** Pointer and keyboard inspection reuse the same bounded chart history. */
export class ChartInspector {
  private points: readonly SignalPoint[] = [];
  private selectedAt: number | null = null;
  private end = 0;
  private upper = 1;
  private readonly line: SVGElement;
  private readonly dot: SVGElement;
  constructor(private readonly plot: HTMLElement, private readonly output: HTMLElement) {
    this.line = plot.querySelector('#inspect-line')!;
    this.dot = plot.querySelector('#inspect-dot')!;
    plot.addEventListener('pointermove', this.onPointer);
    plot.addEventListener('pointerleave', this.onLeave);
    plot.addEventListener('keydown', this.onKey);
    plot.addEventListener('focus', this.onFocus);
    plot.addEventListener('blur', this.onBlur);
  }
  update(points: readonly SignalPoint[], end: number, upper: number): void {
    this.points = points.filter(point => point.at >= end - 90_000 && point.at <= end);
    if (this.selectedAt !== null && !this.points.some(point => point.at === this.selectedAt)) this.selectedAt = null;
    this.end = end; this.upper = upper;
    this.plot.tabIndex = this.points.length ? 0 : -1;
    this.plot.setAttribute('aria-disabled', String(!this.points.length));
    this.plot.setAttribute('aria-valuemax', String(Math.max(0, this.points.length - 1)));
    this.render();
  }
  private readonly onPointer = (event: PointerEvent): void => {
    const bounds = this.plot.getBoundingClientRect();
    const x = bounds.width > 0 ? (event.clientX - bounds.left) / bounds.width : 1;
    this.selectedAt = nearestObservation(this.points, this.end - 90_000 + Math.max(0, Math.min(1, x)) * 90_000)?.at ?? null;
    this.render();
  };
  private readonly onLeave = (): void => { if (document.activeElement !== this.plot) this.reset(); };
  private readonly onFocus = (): void => { this.selectedAt ??= this.points.at(-1)?.at ?? null; this.render(); };
  private readonly onBlur = (): void => this.reset();
  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); this.reset(); return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !this.points.length) return;
    event.preventDefault();
    const current = nearestObservation(this.points, this.selectedAt ?? this.end);
    const at = Math.max(0, this.points.findIndex(point => point === current));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? this.points.length - 1
      : at + (['ArrowLeft', 'ArrowDown'].includes(event.key) ? -1 : 1);
    this.selectedAt = this.points[Math.max(0, Math.min(this.points.length - 1, next))]!.at;
    this.render();
  };
  private reset(): void { this.selectedAt = null; this.render(); }
  private render(): void {
    const point = this.selectedAt === null ? null : nearestObservation(this.points, this.selectedAt);
    this.line.toggleAttribute('hidden', !point); this.dot.toggleAttribute('hidden', !point);
    const value = point ?? this.points.at(-1);
    if (value) {
      const label = `${new Date(value.at).toLocaleTimeString()} · ${value.rate.toFixed(1)} tok/s · ${value.basis === 'observed' ? 'recent output' : value.phase === 'decode' ? 'request average' : 'reported prefill speed'}`;
      this.plot.setAttribute('aria-valuenow', String(this.points.indexOf(value)));
      this.plot.setAttribute('aria-valuetext', label);
      this.output.textContent = point ? label : 'Point to inspect · arrow keys when focused';
    } else {
      this.plot.setAttribute('aria-valuenow', '0');
      this.plot.setAttribute('aria-valuetext', 'No observations yet');
      this.output.textContent = 'History appears as readings arrive';
    }
    if (!point) return;
    // Hold the selected timestamp as new samples arrive; never shift selection by index.
    this.selectedAt = point.at;
    const x = 4 + (point.at - (this.end - 90_000)) / 90_000 * 592;
    const y = 116 - point.rate / this.upper * 112;
    this.line.setAttribute('x1', String(x)); this.line.setAttribute('x2', String(x));
    this.dot.setAttribute('cx', String(x)); this.dot.setAttribute('cy', String(y));
  }
  dispose(): void {
    this.plot.removeEventListener('pointermove', this.onPointer);
    this.plot.removeEventListener('pointerleave', this.onLeave);
    this.plot.removeEventListener('keydown', this.onKey);
    this.plot.removeEventListener('focus', this.onFocus);
    this.plot.removeEventListener('blur', this.onBlur);
  }
}
