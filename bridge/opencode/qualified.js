// Service, panel and qualification tooling only. Not a companion file: qualifying another OpenCode patch changes
// these bytes without asking anyone to reinstall the helper running inside OpenCode.
import { CHAT_PROTOCOL, acceptsRuntime } from './compatibility.js';

/** Versions whose released binary passed the native HTTP, WebSocket, prompt-progress and hot-reload smoke checks. */
export const QUALIFIED_VERSIONS = ['2.0.25', '2.0.27', '2.0.28', '2.0.29', '2.0.32'];
const profiles = QUALIFIED_VERSIONS.map(runtimeVersion => Object.freeze({
  id: `opencode-${runtimeVersion}-v1`, runtimeVersion, protocol: CHAT_PROTOCOL,
  websocketCancellation: runtimeVersion === '2.0.25' ? 'unit-only' : 'native',
}));

/** Matching APIs alone do not qualify event ordering, token semantics, or a transport path. */
export const profileFor = runtimeVersion => profiles.find(profile => runtimeVersion === profile.runtimeVersion) ?? null;
/** `self-checked` versions run the same contract checks as qualified ones, without native evidence of their meaning. */
export const modeFor = runtimeVersion => profileFor(runtimeVersion) ? 'qualified' : acceptsRuntime(runtimeVersion) ? 'self-checked' : 'unsupported';
/** Qualification tooling may run a candidate on the accepted line; it never grants support by itself. */
export const candidateProfile = runtimeVersion => profileFor(runtimeVersion) ?? (acceptsRuntime(runtimeVersion)
  ? Object.freeze({ id: `opencode-${runtimeVersion}-candidate`, runtimeVersion, protocol: CHAT_PROTOCOL, websocketCancellation: 'native', candidate: true })
  : null);
