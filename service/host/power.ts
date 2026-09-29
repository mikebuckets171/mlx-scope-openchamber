import type { PowerV2 } from '../../src/contract/host.ts';
import type { Exec } from '../lib/argv.ts';

// Owner: svc-host. `macmon pipe -i 1000`, streamed with BoundedLines and a 60 s idle-stop; absent without macmon.

export const parseMacmonLine = (line: string, sampledAt: number): Omit<PowerV2, 'coverageFraction'> | null => {
  void line; void sampledAt;
  return null;
};
export interface PowerStream {
  touch(): void;
  /** The newest sample with coverage over the last window; undefined without macmon or samples. */
  view(now: number): PowerV2 | undefined;
  /** Joules over [from, to] when coverage ≥ 0.8 (tok/J and CompletionV2.host.energyJ). */
  energy(from: number, to: number): { energyJ: number; coverage: number } | null;
  dispose(): void;
}
export const createPowerStream = (options: { exec: Exec; macmon: string | null; now: () => number }): PowerStream => {
  void options;
  throw new Error('createPowerStream: not implemented (svc-host)');
};
