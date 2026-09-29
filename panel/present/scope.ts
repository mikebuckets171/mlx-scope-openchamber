import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { RuntimeKind } from '../../src/contract/runtime.ts';
import type { RecentSpeed } from '../insights.ts';
import { connectionName } from './messages.ts';
import type { Coverage, HostReading, Link, Reading, ReadingPhase } from './reading.ts';

/** Everything one render needs; presenters are pure functions of it. */
export interface ScopeInput {
  reading: Reading;                          // the newest reading, available or not
  last: Reading | null;                      // the newest available reading (this one when available)
  host: HostReading | null;                  // this reading's host, else the last one seen
  lastRequest: CompletionV2 | null;          // the newest finished request the service reported
  selectionRuntime: RuntimeKind | null;      // the runtime the user chose, if any
  speed: RecentSpeed | null;                 // observed output speed after this reading
  now: number;                               // the frame's time on the service clock
}

/** The 1.6 panel's shared reading of one poll: what is live, what is retained, and what is being watched. */
export interface Scope extends ScopeInput {
  current: Reading | null;
  display: Reading | null;
  stale: boolean;
  phase: ReadingPhase;
  runtime: RuntimeKind | null;
  link: Link | null;
  name: string;
  splashEngine: boolean;
  coverage: Coverage;
  splashLoading: boolean;
  splashRate: number | null;
  observed: RecentSpeed | null;
  liveRate: number | null;
  logActivity: boolean;
  logRequest: CompletionV2 | null;
  logRate: number | null;
}

export const derive = (input: ScopeInput): Scope => {
  const { reading, last } = input;
  const current = reading.available ? reading : null, display = current ?? last, stale = current === null;
  const phase: ReadingPhase = current?.phase ?? (last ? 'reconnecting' : reading.reason === 'authentication_failed' ? 'offline' : 'connecting');
  const runtime = reading.runtime ?? reading.link?.runtime ?? input.selectionRuntime ?? last?.runtime ?? null;
  const link = reading.link ?? last?.link ?? null;
  const coverage: Coverage = current ? reading.link?.coverage ?? (runtime === 'omlx' ? 'requests' : 'server') : last?.link?.coverage ?? 'requests';
  const decode = current?.request?.decodeTps ?? null;
  const observed = current?.phase === 'decode' && decode === null ? input.speed : null;
  const liveRate = current?.phase === 'decode' ? decode ?? observed?.tokensPerSecond ?? null
    : current?.phase === 'prefill' ? current.request?.prefillTps ?? null : null;
  const logActivity = runtime === 'lmstudio' && coverage === 'requests' && current !== null;
  const logRequest = logActivity ? input.lastRequest : null;
  return {
    ...input, current, display, stale, phase, runtime, link, name: connectionName(runtime, link), splashEngine: link?.engine === 'splash', coverage,
    splashLoading: runtime === 'splash' && display?.splash?.ready === false,
    splashRate: runtime === 'splash' && display?.splash?.ready === true ? display.splash.decodeTps : null,
    observed, liveRate, logActivity, logRequest,
    logRate: logActivity && liveRate === null && phase !== 'decode' && phase !== 'prefill' ? logRequest?.decodeTps ?? null : null,
  };
};
