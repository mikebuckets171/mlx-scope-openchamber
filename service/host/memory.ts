import { defined, oneOf } from '../../src/contract/guards.ts';
import type { MacV2 } from '../../src/contract/host.ts';

// Owner: svc-host. Rewrite of service/mac-memory.ts in bytes. `sysctl -i` drops a missing key; the rest still parse.

const bytes = (value: number): number | undefined => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** vm_stat prints its page size; Apple Silicon must not be assumed to use 4 KiB pages. */
export const parseVmStat = (output: string | null): Pick<MacV2, 'wiredBytes' | 'compressedBytes'> => {
  const text = output ?? '';
  const pageSize = Number(/^Mach Virtual Memory Statistics: \(page size of (\d{1,6}) bytes\)$/m.exec(text)?.[1]);
  if (!(Number.isSafeInteger(pageSize) && pageSize >= 1024 && pageSize <= 65_536 && (pageSize & (pageSize - 1)) === 0)) return {};
  const pages = (label: string): number | undefined => {
    const match = new RegExp(`^${label}:[ ]+(\\d{1,16})\\.$`, 'm').exec(text);
    return match ? bytes(Number(match[1]) * pageSize) : undefined;
  };
  // The compressor's physical footprint ("occupied by"), not the logical pages it stores.
  return defined({ wiredBytes: pages('Pages wired down'), compressedBytes: pages('Pages occupied by compressor') });
};

const UNIT: Record<string, number> = { K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40 };
const pressureLevel = oneOf([1, 2, 4] as const);
const value = (text: string, key: string): string | undefined =>
  new RegExp(`^${key.replaceAll('.', '\\.')}: (.+)$`, 'm').exec(text)?.[1]?.trim();
const swap = (field: 'total' | 'used', line: string | undefined): number | undefined => {
  const match = new RegExp(`(?:^|\\s)${field} = (\\d{1,12}(?:\\.\\d{1,2})?)([KMGT])(?=\\s|$)`).exec(line ?? '');
  return match ? bytes(Math.round(Number(match[1]) * UNIT[match[2]!]!)) : undefined;
};

/**
 * `sysctl -i vm.swapusage kern.memorystatus_vm_pressure_level iogpu.wired_limit_mb`. The kernel's own pressure level
 * (1 normal, 2 warning, 4 critical; anything else is left out), never one inferred from occupancy. A wired limit of 0 means
 * "macOS default", not a 0-byte limit, so it is left out.
 */
export const parseSysctl = (output: string | null): Pick<MacV2, 'pressureLevel' | 'wiredLimitBytes' | 'swapUsedBytes' | 'swapTotalBytes'> => {
  const text = output ?? '';
  const level = value(text, 'kern.memorystatus_vm_pressure_level'), limit = value(text, 'iogpu.wired_limit_mb');
  const swapLine = value(text, 'vm.swapusage');
  return defined({
    pressureLevel: level !== undefined && /^\d{1,2}$/.test(level) ? pressureLevel(Number(level)) ?? undefined : undefined,
    wiredLimitBytes: limit !== undefined && /^[1-9]\d{0,9}$/.test(limit) ? bytes(Number(limit) * UNIT.M!) : undefined,
    swapUsedBytes: swap('used', swapLine), swapTotalBytes: swap('total', swapLine),
  });
};
