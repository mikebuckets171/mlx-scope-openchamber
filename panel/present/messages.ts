import { runtimeNames, type RuntimeKind } from '../../src/contract/runtime.ts';
import type { Link, ReadingPhase } from './reading.ts';

// The panel's English. Stage 2a keeps every 1.6 string; the service's own 1.6 lines still arrive in `compat.message`
// until Stage 2b moves them here as reason codes.
export const PHASES: Record<ReadingPhase, string> = {
  connecting: 'Connecting', reconnecting: 'Reconnecting', offline: 'Offline', notLoaded: 'No model', idle: 'Ready', queued: 'Queued',
  prefill: 'Reading context', decode: 'Generating', processing: 'Processing', unknown: 'Unavailable',
};
/** Resident model rows use their own shorter vocabulary. */
export const RESIDENT_PHASES: Partial<Record<ReadingPhase, string>> = {
  decode: 'Generating', prefill: 'Reading context', idle: 'Ready', queued: 'Queued', processing: 'Processing', unknown: 'Unavailable',
};

/** What is actually being monitored, e.g. "Splash via Bionic" rather than "LM Studio". */
export const connectionName = (runtime: RuntimeKind | null | undefined, link?: Pick<Link, 'engine' | 'host'> | null): string => {
  if (runtime === 'lmstudio') {
    if (link?.engine === 'splash') return link.host === 'bionic' ? 'Splash via Bionic' : 'Splash via LM Studio';
    if (link?.host === 'bionic') return 'Bionic';
  }
  return runtime ? runtimeNames[runtime] : 'Local runtime';
};

export const CONTRACT_MISMATCH = 'MLX Scope was updated, but its local service is still the previous version. Pause and resume MLX Scope in Settings → Extensions.';
export const NO_FRESH_READING = 'No fresh observations. Retained readings are not live.';
export const CONNECTION_CLEARED = 'Waiting for the selected connection. Existing observations were cleared.';
export const CHOOSE_CONNECTION = 'Choose an existing local OpenCode connection, then refresh. Connection help can check the extension service.';
