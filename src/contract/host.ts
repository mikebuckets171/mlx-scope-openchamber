import type { CapabilityDescriptor } from './capabilities.ts';
import { at, count, defined, fraction, label, list, nonneg, obj, oneOf, opt, optionalFields } from './guards.ts';

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
  apps?: HostAppsV2;
}
/**
 * 5.5: the apps holding the most memory (physical footprint, Activity Monitor's figure), read only while the runtime is
 * short of room. Names stay on this Mac: shown live and kept beside waits in local History, never exported.
 */
export interface HostAppsV2 {
  sampledAt: number;
  /** When the comparison read was taken (the first read after the room went short); growth is measured from it. */
  sinceAt?: number;
  items: Array<{ name: string; bytes: number; grewBytes?: number }>;   // ≤ 8, biggest first; grewBytes > 0 only
}
export const HOST_APPS_MAX = 8;
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

const pressureLevel = oneOf([1, 2, 4] as const);
export const thermalLevel = oneOf([0, 1, 2, 3, 4] as const);
const part = <T extends object>(value: unknown, build: (item: Record<string, unknown>, sampledAt: number) => T | null): T | undefined => {
  const item = obj(value), sampledAt = at(item?.sampledAt);
  return item && sampledAt !== null ? opt(build(item, sampledAt)) : undefined;
};

const macFields = optionalFields({ pressureLevel, wiredLimitBytes: count, swapUsedBytes: count, swapTotalBytes: count,
  wiredBytes: count, compressedBytes: count });
const gpuFields = optionalFields({ busyFraction: fraction, allocBytes: count, inUseBytes: count });
const powerFields = optionalFields({ cpuW: nonneg, gpuW: nonneg, aneW: nonneg });

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
    mac: platform === null || platform === 'macOS' ? part(item.mac, (mac, at): MacV2 => ({ sampledAt: at, ...macFields(mac) })) : undefined,
    gpu: part(item.gpu, (gpu, at) => ({ sampledAt: at, ...gpuFields(gpu) })),
    thermal: part(item.thermal, (thermal, at) => { const level = thermalLevel(thermal.level); return level === null ? null : { sampledAt: at, level }; }),
    runtimeProcess: part(item.runtimeProcess, (process, at) => {
      const port = count(process.port), footprint = count(process.footprintBytes);
      return process.runtime === 'omlx' && port !== null && port >= 1 && port <= 65_535 && footprint !== null
        ? { sampledAt: at, runtime: 'omlx' as const, port, footprintBytes: footprint } : null;
    }),
    power: part(item.power, (power, at): PowerV2 | null => {
      const chip = nonneg(power.chipW), coverage = fraction(power.coverageFraction), sys = nonneg(power.sysW);
      return power.field === 'all_power' && chip !== null && coverage !== null ? defined({ sampledAt: at, field: 'all_power' as const,
        chipW: chip, ...powerFields(power),
        // macmon writes 0 when the SMC estimate is unavailable; zero is "not reported", not zero watts.
        sysW: sys ? sys : undefined, coverageFraction: coverage }) : null;
    }),
    apps: part(item.apps, (apps, sampled): HostAppsV2 | null => {
      const since = at(apps.sinceAt), items = list(apps.items, HOST_APPS_MAX, raw => {
        const app = obj(raw), name = label(app?.name, 48), bytes = count(app?.bytes), grew = count(app?.grewBytes);
        // Growth only: an app that shrank since the comparison read took no room.
        return name && bytes !== null ? defined({ name, bytes, grewBytes: grew ? grew : undefined }) : null;
      }).sort((a, b) => b.bytes - a.bytes);
      return items.length ? defined({ sampledAt: sampled, sinceAt: since !== null && since <= sampled ? since : undefined, items }) : null;
    }),
  });
};

/**
 * The host capabilities a reading fills (P3: exactly the parts present, so a probe with no reading claims nothing). Only
 * macmon power is an `estimate`; the rest the kernel, driver or `footprint` reported.
 */
export const hostCapabilities = (host: HostV2 | null | undefined): CapabilityDescriptor[] => {
  if (!host) return [];
  const { mac, gpu } = host, has = (...values: unknown[]): boolean => values.some(value => value !== undefined);
  const present: Array<[CapabilityDescriptor['key'], boolean]> = [
    ['host.cpu', has(host.cpuFraction)],
    ['host.memory', has(host.memUsedBytes, host.memTotalBytes, mac?.wiredBytes, mac?.compressedBytes)],
    ['host.swap', has(mac?.swapUsedBytes, mac?.swapTotalBytes)], ['host.pressure', has(mac?.pressureLevel)],
    ['host.wiredLimit', has(mac?.wiredLimitBytes)], ['host.gpuBusy', has(gpu?.busyFraction)],
    ['host.gpuMemory', has(gpu?.allocBytes, gpu?.inUseBytes)], ['host.thermal', has(host.thermal)],
    ['host.footprint', has(host.runtimeProcess)], ['host.power', has(host.power)], ['host.apps', has(host.apps)],
  ];
  return present.filter(([, on]) => on).map(([key]) => ({ key, basis: key === 'host.power' ? 'estimate' : 'reported' }));
};
