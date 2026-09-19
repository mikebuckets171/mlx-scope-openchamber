/** Whole-host observations. Never infer OS pressure from memory occupancy. */
export type MacMemory = {
  wiredGB: number | null;
  compressedGB: number | null;
  swapUsedGB: number | null;
  sampledAt: number;
};

export type SystemSnapshot = {
  platform: string;
  cpuModel: string | null;
  logicalCores: number | null;
  cpuPercent: number | null;
  memoryUsedGB: number | null;
  memoryTotalGB: number | null;
  macOS: MacMemory | null;
  sampledAt: number;
};

const object = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);
const finite = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
);
const platforms: Record<string, string> = { darwin: 'macOS', macOS: 'macOS', linux: 'Linux', Linux: 'Linux', win32: 'Windows', Windows: 'Windows' };

export const parseSystemSnapshot = (value: unknown): SystemSnapshot | null => {
  const data = object(value);
  if (!data || typeof data.platform !== 'string') return null;
  const sampledAt = finite(data.sampledAt);
  if (sampledAt === null) return null;
  const native = object(data.macOS);
  const nativeAt = finite(native?.sampledAt);
  const cpu = finite(data.cpuPercent);
  const cores = finite(data.logicalCores);
  const total = finite(data.memoryTotalGB);
  const used = finite(data.memoryUsedGB);
  const macOS = native && nativeAt !== null ? {
    wiredGB: finite(native.wiredGB),
    compressedGB: finite(native.compressedGB),
    swapUsedGB: finite(native.swapUsedGB),
    sampledAt: nativeAt,
  } satisfies MacMemory : null;
  return {
    platform: Object.hasOwn(platforms, data.platform) ? platforms[data.platform]! : 'Host',
    cpuModel: typeof data.cpuModel === 'string' ? data.cpuModel.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80) || null : null,
    logicalCores: cores !== null && Number.isInteger(cores) && cores > 0 ? cores : null,
    cpuPercent: cpu !== null && cpu <= 100 ? cpu : null,
    memoryUsedGB: used !== null && total !== null && used > total ? null : used,
    memoryTotalGB: total !== null && total > 0 ? total : null,
    macOS: data.platform === 'darwin' || data.platform === 'macOS' ? macOS : null,
    sampledAt,
  };
};
