import { thermalLevel, type ThermalLevel } from '../../src/contract/host.ts';

// Owner: svc-host. `notifyutil -g com.apple.system.thermalpressurelevel`; "Failed with code" on stdout is a failure.

/** macOS levels 0 nominal … 4 sleeping (OSThermalNotification.h); the non-macOS 10–50 scale and failures are dropped. */
export const parseNotifyutil = (output: string | null): ThermalLevel | null => {
  const match = /^com\.apple\.system\.thermalpressurelevel (\d{1,3})\n?$/.exec(output ?? '');
  return match ? thermalLevel(Number(match[1])) : null;
};
