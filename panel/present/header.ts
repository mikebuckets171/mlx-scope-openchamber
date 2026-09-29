import { age } from './format.ts';
import { CHOOSE_CONNECTION, PHASES } from './messages.ts';
import type { Scope } from './scope.ts';

/** The masthead, the hero heading and the frame-wide state: what is being watched and whether it is live. */
export interface HeaderView {
  dataset: { coverage: string; runtime: string; engine: string; empty: string; phase: string; stale: string };
  activityLabel: string; instrumentLabel: string; instrumentHidden: boolean;
  diagnosisHidden: boolean; connectionMessage: string;
  coverageNote: string; coverageNoteHidden: boolean;
  connection: string; phase: string; model: string; modelTitle: string; splashDetail: string;
  notice: string; noticeHidden: boolean; freshness: string; saveDisabled: boolean;
}

export const presentHeader = (s: Scope): HeaderView => {
  const { current, display, stale, runtime, name, coverage, reading, last, now } = s;
  const empty = stale && last === null;
  const splash = runtime === 'splash', requests = coverage === 'requests';
  const noModel = s.splashEngine && runtime === 'lmstudio' && s.phase === 'notLoaded';
  const shortModel = display?.model?.split('/').at(-1);
  const connection = current ? `${name}${s.splashLoading ? ' · loading model' : ' connected'}${current.phase === 'notLoaded' ? ' · no model loaded' : ''}`
    : reading.reason === 'authentication_failed' ? 'Authentication required' : `Waiting for ${name}`;
  const phase = current && splash ? s.splashLoading ? 'Loading' : current.phase === 'processing' ? 'Generating' : current.phase === 'idle' ? 'Idle' : 'Ready'
    : current && !requests ? 'Connected' : PHASES[s.phase];
  const model = noModel ? 'No model loaded' : splash ? shortModel ?? 'Splash server' : current && !requests ? name : shortModel ?? 'Your local model';
  return {
    dataset: { coverage, runtime: runtime ?? '', engine: s.splashEngine ? 'splash' : '', empty: String(empty), phase: s.phase, stale: String(stale) },
    activityLabel: requests ? 'MODEL ACTIVITY' : 'LOCAL RUNTIME',
    instrumentLabel: requests ? 'Inference activity' : 'Runtime inventory and coverage', instrumentHidden: empty,
    diagnosisHidden: !stale, connectionMessage: stale ? reading.message ?? CHOOSE_CONNECTION : '',
    // One quiet line for runtimes that list models but do not stream request activity; Splash says nothing here.
    coverageNoteHidden: !current || requests || splash,
    coverageNote: coverage === 'inventory'
      ? `${name} lists its models here. Live request activity appears when its local log stream is available.`
      : `${name} is reachable. It does not report live request progress.`,
    connection, phase, model, modelTitle: display?.model ?? `Observing ${name} on the OpenChamber host.`,
    splashDetail: splash && display?.contextWindowTokens != null ? `${display.contextWindowTokens.toLocaleString()}-token context` : '',
    notice: stale && last ? `${age(last.sampledAt, now)}. Retained details are not live.` : '', noticeHidden: !stale || last === null,
    freshness: display ? age(display.sampledAt, now) : 'No sample yet',
    saveDisabled: !reading.available && !reading.host,
  };
};
