import type { HostV2 } from '../../src/contract/host.ts';

// Owner: svc-host. ioreg IOAccelerator PerformanceStatistics: driver-reported; never a headline, score or alert (G1).

export const parseIoreg = (output: string | null, sampledAt: number): HostV2['gpu'] | undefined => {
  void output; void sampledAt;
  return undefined;
};
