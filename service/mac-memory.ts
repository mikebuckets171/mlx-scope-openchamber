import { readCommand } from './native-command.ts';
import type { MacMemory } from '../src/system.ts';

export const MAC_SAMPLE_INTERVAL_MS = 10_000;
export const MAC_COMMAND_TIMEOUT_MS = 1_500;
export const MAC_COMMAND_MAX_BYTES = 64 * 1024;
// No shell, PATH lookup, user-controlled arguments, elevation or persistent helper.
const COMMANDS = [
  ['/usr/bin/vm_stat', []],
  ['/usr/sbin/sysctl', ['vm.swapusage']],
] as const;
export type NativeRead = (file: string, args: readonly string[]) => Promise<string | null>;

export const readNative: NativeRead = (file, args) => readCommand(file, args, MAC_COMMAND_TIMEOUT_MS, MAC_COMMAND_MAX_BYTES);

const bytesToGB = (value: number): number | null => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value / 1e9 : null;

/** vm_stat supplies the page size. Apple Silicon must not be assumed to use 4 KiB. */
export const parseVMStat = (output: string | null): Pick<MacMemory, 'wiredGB' | 'compressedGB'> => {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output ?? '')?.[1]);
  const validPageSize = Number.isSafeInteger(pageSize) && pageSize >= 1024 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0;
  const pages = (label: string): number | null => {
    if (!validPageSize) return null;
    const match = new RegExp(`^${label}:\\s+(\\d+)\\.?(?:\\s|$)`, 'm').exec(output ?? '');
    return match ? bytesToGB(Number(match[1]) * pageSize) : null;
  };
  return { wiredGB: pages('Pages wired down'), compressedGB: pages('Pages occupied by compressor') };
};

/** Read only the swap usage returned by the macOS sysctl utility. */
export const parseSysctlMemory = (output: string | null): Pick<MacMemory, 'swapUsedGB'> => {
  const swapLine = /^vm\.swapusage:\s*(.*)$/m.exec(output ?? '')?.[1] ?? '';
  const used = /\bused\s*=\s*(\d+(?:\.\d+)?)\s*([KMGT])(?:\s|$)/.exec(swapLine);
  const powers: Record<string, number> = { K: 1, M: 2, G: 3, T: 4 };
  return {
    swapUsedGB: used ? bytesToGB(Number(used[1]) * 1024 ** powers[used[2]!]!) : null,
  };
};

/** Demand-driven: at most two short processes per 10 seconds across all surfaces. */
export class MacMemorySampler {
  private cached: MacMemory | null = null;
  private pending: Promise<MacMemory> | null = null;
  constructor(private readonly read: NativeRead = readNative, private readonly now: () => number = Date.now) {}

  sample(): Promise<MacMemory> {
    if (this.pending) return this.pending;
    const age = this.cached ? this.now() - this.cached.sampledAt : Infinity;
    if (this.cached && age >= 0 && age < MAC_SAMPLE_INTERVAL_MS) return Promise.resolve(this.cached);
    this.pending = Promise.all(COMMANDS.map(([file, args]) => Promise.resolve().then(() => this.read(file, args)).catch(() => null)))
      .then(([vm, sysctl]) => {
        this.cached = { ...parseVMStat(vm ?? null), ...parseSysctlMemory(sysctl ?? null), sampledAt: this.now() };
        return this.cached;
      }).finally(() => { this.pending = null; });
    return this.pending;
  }
}
