import { cpus, freemem, totalmem, platform } from 'node:os';
import type { SystemSnapshot } from '../src/system.ts';
import { MacMemorySampler } from './mac-memory.ts';

export type CPUTicks = { idle: number; total: number };
export const cpuUsage = (previous: CPUTicks | null, current: CPUTicks): number | null => {
  if (previous === null) return null;
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (!Number.isFinite(total) || !Number.isFinite(idle) || total <= 0 || idle < 0 || idle > total) return null;
  return (1 - idle / total) * 100;
};

type Options = {
  now?: () => number;
  readCPUs?: typeof cpus;
  readFree?: typeof freemem;
  readTotal?: typeof totalmem;
  hostPlatform?: string;
  native?: Pick<MacMemorySampler, 'sample'>;
};

/** No background timer. Basic readings are shared for 2s, macOS diagnostics for 10s. */
export class SystemSampler {
  private previous: CPUTicks | null = null;
  private cached: SystemSnapshot | null = null;
  private pending: Promise<SystemSnapshot> | null = null;
  private readonly now: () => number;
  private readonly native: Pick<MacMemorySampler, 'sample'>;
  constructor(private readonly options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.native = options.native ?? new MacMemorySampler(undefined, this.now);
  }

  sample(): Promise<SystemSnapshot> {
    if (this.pending) return this.pending;
    const age = this.cached ? this.now() - this.cached.sampledAt : Infinity;
    if (this.cached && age >= 0 && age < 2_000) return Promise.resolve(this.cached);
    this.pending = this.collect(age).then((snapshot) => { this.cached = snapshot; return snapshot; })
      .finally(() => { this.pending = null; });
    return this.pending;
  }

  private async collect(age: number): Promise<SystemSnapshot> {
    const hostPlatform = this.options.hostPlatform ?? platform();
    const macOS = hostPlatform === 'darwin' ? await this.native.sample().catch(() => null) : null;
    const cores = (this.options.readCPUs ?? cpus)();
    const ticks = cores.reduce((result, cpu) => ({ idle: result.idle + cpu.times.idle,
      total: result.total + Object.values(cpu.times).reduce((sum, time) => sum + time, 0) }), { idle: 0, total: 0 });
    const total = (this.options.readTotal ?? totalmem)();
    const free = (this.options.readFree ?? freemem)();
    const validMemory = Number.isFinite(total) && total > 0 && Number.isFinite(free) && free >= 0 && free <= total;
    // After suspension/long gaps, re-prime: an average over sleep is not current CPU.
    const cpuPercent = cores.length > 0 && age >= 0 && age <= 10_000 ? cpuUsage(this.previous, ticks) : null;
    this.previous = ticks;
    return {
      platform: hostPlatform, cpuModel: cores[0]?.model.trim().slice(0, 80) || null,
      logicalCores: cores.length || null, cpuPercent,
      memoryUsedGB: validMemory ? (total - free) / 1e9 : null,
      memoryTotalGB: validMemory ? total / 1e9 : null,
      macOS, sampledAt: this.now(),
    };
  }
}
