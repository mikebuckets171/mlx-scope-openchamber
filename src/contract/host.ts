import { at, count, defined, fraction, label, nonneg, obj, oneOf, opt } from './guards.ts';

export const PLATFORMS = ['macOS', 'Linux', 'Windows', 'Host'] as const;
export type Platform = typeof PLATFORMS[number];
export type PressureLevel = 1 | 2 | 4;
export type ThermalLevel = 0 | 1 | 2 | 3 | 4;

/** Whole-host readings. Each part carries its own `sampledAt`; a part is absent when its probe has no reading. */
export interface HostV2 {
  sampledAt: number;
  platform?: Platform;                       // 2a amendment: the 1.6 host card title
  cpuModel?: string;                         // 2a amendment: the 1.6 hardware line
  logicalCores?: number;                     // 2a amendment
  cpuFraction?: number;                      // 2a amendment: absent until two CPU samples exist
  memTotalBytes?: number;                    // 2a amendment: absent when the OS reading is invalid
  memUsedBytes?: number;                     // physical minus free; includes reclaimable pages (1.6 meaning)
  mac?: MacV2;
  gpu?: { sampledAt: number; busyFraction?: number; allocBytes?: number; inUseBytes?: number };   // ioreg, driver-reported
  thermal?: { sampledAt: number; level: ThermalLevel };    // notifyutil com.apple.system.thermalpressurelevel
  runtimeProcess?: { sampledAt: number; runtime: 'omlx'; port: number; footprintBytes: number };   // never a PID
  power?: PowerV2;
}
export interface MacV2 {
  sampledAt: number;
  pressureLevel?: PressureLevel;             // 2a amendment: optional until Stage 5 reads the kernel level
  wiredLimitBytes?: number;
  swapUsedBytes?: number;                    // 2a amendment: optional; sysctl output can be unparseable
  swapTotalBytes?: number;
  wiredBytes?: number;
  compressedBytes?: number;
}
export interface PowerV2 {
  sampledAt: number; field: 'all_power'; chipW: number; cpuW?: number; gpuW?: number; aneW?: number;
  sysW?: number; coverageFraction: number;   // macmon; absent without macmon (Scope never installs it)
}

const bytes = (value: unknown): number | undefined => opt(count(value));
const pressureLevel = oneOf([1, 2, 4] as const);
export const thermalLevel = oneOf([0, 1, 2, 3, 4] as const);
const part = <T extends object>(value: unknown, build: (item: Record<string, unknown>, sampledAt: number) => T | null): T | undefined => {
  const item = obj(value), sampledAt = at(item?.sampledAt);
  return item && sampledAt !== null ? opt(build(item, sampledAt)) : undefined;
};

export const parseHostV2 = (value: unknown): HostV2 | null => {
  const item = obj(value), sampledAt = at(item?.sampledAt);
  if (!item || sampledAt === null) return null;
  const total = count(item.memTotalBytes), used = count(item.memUsedBytes), cores = count(item.logicalCores);
  const platform = oneOf(PLATFORMS)(item.platform);
  return defined({
    sampledAt, platform: opt(platform), cpuModel: opt(label(item.cpuModel, 80)), logicalCores: cores ? cores : undefined,
    cpuFraction: opt(fraction(item.cpuFraction)),
    memTotalBytes: total ? total : undefined,
    // Used above total is a broken reading, not a full machine.
    memUsedBytes: used !== null && (total === null || used <= total) ? used : undefined,
    mac: platform === null || platform === 'macOS' ? part(item.mac, (mac, at): MacV2 => defined({ sampledAt: at,
      pressureLevel: opt(pressureLevel(mac.pressureLevel)), wiredLimitBytes: bytes(mac.wiredLimitBytes),
      swapUsedBytes: bytes(mac.swapUsedBytes), swapTotalBytes: bytes(mac.swapTotalBytes),
      wiredBytes: bytes(mac.wiredBytes), compressedBytes: bytes(mac.compressedBytes) })) : undefined,
    gpu: part(item.gpu, (gpu, at) => defined({ sampledAt: at, busyFraction: opt(fraction(gpu.busyFraction)),
      allocBytes: bytes(gpu.allocBytes), inUseBytes: bytes(gpu.inUseBytes) })),
    thermal: part(item.thermal, (thermal, at) => { const level = thermalLevel(thermal.level); return level === null ? null : { sampledAt: at, level }; }),
    runtimeProcess: part(item.runtimeProcess, (process, at) => {
      const port = count(process.port), footprint = count(process.footprintBytes);
      return process.runtime === 'omlx' && port !== null && port >= 1 && port <= 65_535 && footprint !== null
        ? { sampledAt: at, runtime: 'omlx' as const, port, footprintBytes: footprint } : null;
    }),
    power: part(item.power, (power, at): PowerV2 | null => {
      const chip = nonneg(power.chipW), coverage = fraction(power.coverageFraction), sys = nonneg(power.sysW);
      return power.field === 'all_power' && chip !== null && coverage !== null ? defined({ sampledAt: at, field: 'all_power' as const,
        chipW: chip, cpuW: opt(nonneg(power.cpuW)), gpuW: opt(nonneg(power.gpuW)), aneW: opt(nonneg(power.aneW)),
        // macmon writes 0 when the SMC estimate is unavailable; zero is "not reported", not zero watts.
        sysW: sys ? sys : undefined, coverageFraction: coverage }) : null;
    }),
  });
};
