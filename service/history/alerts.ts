import type { AlertLogEntryV2, AlertV2 } from '../../src/contract/alerts.ts';
import type { HostV2 } from '../../src/contract/host.ts';
import type { Phase, StatusV2 } from '../../src/contract/snapshot.ts';

// Owner: svc-history. Host and runtime alerts evaluated at request time (plan §5.7 minus near-gpu-limit): hysteresis,
// dwell and cooldown on a fake-clock table; windowed alerts only inside one contiguous segment with ≥ 80 % coverage.

export const TOAST_LIMITS = { perMinute: 1, perHour: 3 } as const;
export interface AlertInput {
  at: number;
  status: StatusV2;
  phase: Phase;
  loadedModels: number | null;               // model-unloaded fires on a drop to 0
  host: HostV2 | null;
  covered: boolean;                          // this reading continues the current segment
}
export class AlertBook {
  evaluate(input: AlertInput): void { void input; }
  /** Active alerts (toastSeq only for the leader, rate-limited) and the ≤ 20 entry log, newest first. */
  view(leader: boolean, now: number): { alerts: AlertV2[]; alertLog: AlertLogEntryV2[] } { void leader; void now; return { alerts: [], alertLog: [] }; }
}
/** ≤ 1 toast per minute and ≤ 3 per hour, in service memory. */
export class ToastLimiter {
  allow(now: number): boolean { void now; return false; }
}
