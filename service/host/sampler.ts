import type { HostV2 } from '../../src/contract/host.ts';
import type { Tier } from '../core/adapter-v2.ts';
import type { Exec } from '../lib/argv.ts';

// Owner: svc-host. Rewrite of service/system.ts on HostV2 with the §4.4 probe tiers and spawn budget. setTimeout only.

/** Probe cadences in ms (contract §8): [full idle, full active, glance]; null = not on that tier. */
export const PROBE_CADENCE = {
  memory: [10_000, 10_000, 10_000], gpu: [15_000, 5_000, 15_000], thermal: [60_000, 60_000, 60_000],
  listener: [120_000, 120_000, null], footprint: [30_000, 10_000, null],
} as const;
export const SPAWN_BUDGET_PER_MIN = { idle: 24, active: 36, glance: 18 } as const;

/** What the sampler needs from the reading it rides along with. `omlxPort` enables lsof → footprint. */
export interface HostContext { tier: Tier; active: boolean; generation: number; omlxPort: number | null }
export interface HostSamplerOptions { exec: Exec; now: () => number; platform?: string; home?: string }

export class HostSampler {
  constructor(private readonly options: HostSamplerOptions) {}
  /** Cached parts younger than their cadence are reused; a part without a reading is left out. */
  async sample(context: HostContext): Promise<HostV2 | null> {
    void this.options; void context;
    throw new Error('HostSampler: not implemented (svc-host)');
  }
  /** Stops the macmon stream and pending timers. */
  dispose(): void {}
}
