import type { ThermalLevel } from '../../src/contract/host.ts';

// Owner: svc-host. `notifyutil -g com.apple.system.thermalpressurelevel`; "Failed with code" on stdout is a failure.

export const parseNotifyutil = (output: string | null): ThermalLevel | null => { void output; return null; };
