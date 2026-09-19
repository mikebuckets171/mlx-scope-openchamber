import type { SystemSnapshot } from '../src/system.ts';

const WINDOW_MS = 90_000;
type Reading = { at: number; cpu: number | null; memory: number | null; segment: number };
/** Separate from inference: host samples have their own clock and 2s cadence. */
export class ResourceHistory {
  private samples: Reading[] = [];
  private segment = 0;
  private disconnected = true;
  get size(): number { return this.samples.length; }
  break(): void { this.disconnected = true; }
  observe(system: SystemSnapshot | null): void {
    if (!system) { this.break(); return; }
    const last = this.samples.at(-1);
    if (last && system.sampledAt <= last.at) return;
    if (this.disconnected || !last || system.sampledAt - last.at > 5_000) this.segment++;
    this.disconnected = false;
    const total = system.memoryTotalGB;
    this.samples.push({ at: system.sampledAt, cpu: system.cpuPercent,
      memory: total !== null && total > 0 && system.memoryUsedGB !== null ? system.memoryUsedGB / total * 100 : null,
      segment: this.segment });
    this.samples = this.samples.filter((point) => point.at >= system.sampledAt - WINDOW_MS).slice(-100);
  }
  paths(metric: 'cpu' | 'memory', now: number): string {
    let previous: Reading | null = null;
    return this.samples.filter((point) => point.at >= now - WINDOW_MS && point.at <= now).map((point) => {
      const value = point[metric];
      if (value === null || !Number.isFinite(value) || value < 0 || value > 100) { previous = null; return ''; }
      const command = previous?.segment === point.segment ? 'L' : 'M';
      previous = point;
      const x = 2 + (point.at - (now - WINDOW_MS)) / WINDOW_MS * 296;
      const y = 58 - value / 100 * 56;
      return `${command}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
  }
}

/** Wire contract uses decimal GB; all memory values in the UI use binary GiB. */
export const toGiB = (gb: number): number => gb * 1e9 / 1024 ** 3;
