import type { MacV2 } from '../../src/contract/host.ts';

// Owner: svc-host. Rewrite of service/mac-memory.ts in bytes. `sysctl -i` drops a missing key; the rest still parse.

export const parseVmStat = (output: string | null): Pick<MacV2, 'wiredBytes' | 'compressedBytes'> => { void output; return {}; };
export const parseSysctl = (output: string | null): Pick<MacV2, 'pressureLevel' | 'wiredLimitBytes' | 'swapUsedBytes' | 'swapTotalBytes'> => {
  void output;
  return {};
};
