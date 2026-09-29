import type { EngineV2, ResidencyV2 } from '../../src/contract/snapshot.ts';
import type { Exec } from '../lib/argv.ts';

// Owner: ad-lmstudio. One-shot `lms ps --json` / `lms runtime ls` with the no-wake env and --port (service/lib/argv.ts
// lmsArgv). native-command.ts cannot pass env, so the one-shot spawner lives here. Cadence: ps on a generation change,
// else 180 s, full tier only, never under 60 s; runtime ls only with detail=server, cached 10 min.

export const LMS_PS_MIN_MS = 60_000;
export const LMS_PS_EVERY_MS = 180_000;
export const LMS_RUNTIME_CACHE_MS = 600_000;
export const parseLmsPs = (text: string): ResidencyV2[] => { void text; return []; };
export const parseRuntimeLs = (text: string): EngineV2[] => { void text; return []; };
export interface LmsCli {
  ps(port: number, generation: number): Promise<ResidencyV2[] | null>;
  runtimeLs(port: number): Promise<EngineV2[] | null>;
}
export const createLmsCli = (options: { exec: Exec; lms: string | null; serverInfoPath: string; now: () => number }): LmsCli => {
  void options;
  throw new Error('createLmsCli: not implemented (ad-lmstudio)');
};
