// Upstream support, Scope's wire format, and the companion package version are independent.
// Keep the legacy protocol spelling so an updated helper still interoperates with existing readers.
export const CHAT_PROTOCOL = 'opencode-2.0.25';
export const TELEMETRY_SCHEMA_VERSION = 1;
export const FEATURE_IDS = ['http-delivery', 'websocket-delivery', 'prompt-progress', 'managed-reload'];
/** Why a running check withdrew a feature. Codes only; never paths, messages or event contents. */
export const CHECK_REASONS = ['hook-missing', 'hook-rejected', 'events-missing', 'event-shape', 'session-header', 'options'];
const CHECK_STATES = ['waiting', 'passed', 'failed'];

/** OpenCode 2.0.25 introduced the public plugin and event contract this helper reads. */
const FIRST_PATCH = 25;
/**
 * Locally built runtimes report a suffixed version, which no rule can bound. Only reviewed identifiers are listed,
 * never a pattern: an unreviewed build stays unsupported, exactly as a different major release does.
 */
export const REVIEWED_BUILDS = ['2.1.1-compaction.1'];
/**
 * Every OpenCode 2 release from 2.0.25 is accepted: minor releases have kept the contract (v2.0.32 → v2.1.1 → v2.2.0
 * compared tag to tag), and the checks below withdraw only the feature whose hook or event shape a release changes, so
 * a new minor needs no new helper. 2.1 changed how a compaction stores what it keeps (`metadata.keepID`, and the
 * `metadata.recent` that `session.context` materializes) and renamed optional `providerState` to `native`; 2.2 dropped
 * the unused `Session.Event.Source` schema. None of those is read here; `session.compaction.started` is only a reset
 * signal. A new major is a different contract and stays unsupported until reviewed.
 * Which versions were natively qualified is the service's record (qualified.js), so qualifying one never changes these bytes.
 */
export const acceptsRuntime = runtimeVersion => {
  if (typeof runtimeVersion !== 'string') return false;
  if (REVIEWED_BUILDS.includes(runtimeVersion)) return true;
  const match = /^2\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.exec(runtimeVersion);
  return !!match && (match[1] !== '0' || Number(match[2]) >= FIRST_PATCH);
};
export const acceptsChatProtocol = (runtimeVersion, protocol) => acceptsRuntime(runtimeVersion) && protocol === CHAT_PROTOCOL;
export const featureSupport = runtimeVersion => Object.fromEntries(FEATURE_IDS.map(id =>
  [id, { support: acceptsRuntime(runtimeVersion) ? 'compatible' : 'unqualified', available: false }]));

const parseCheck = value => {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !CHECK_STATES.includes(value.state)) return undefined;
  if (value.reason === undefined) return value.state === 'failed' ? undefined : { state: value.state };
  return value.state === 'failed' && CHECK_REASONS.includes(value.reason) ? { state: 'failed', reason: value.reason } : undefined;
};

/** Optional heartbeat extension. Ignore unknown features and reject contradictory claims. 3.3 helpers say `qualified`. */
export function parseFeatures(value, runtimeVersion) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = featureSupport(runtimeVersion), accepted = acceptsRuntime(runtimeVersion);
  for (const id of FEATURE_IDS) {
    const item = value[id];
    if (!item || typeof item !== 'object' || !['compatible', 'qualified', 'unqualified', 'unavailable'].includes(item.support)
      || typeof item.available !== 'boolean') return undefined;
    const support = item.support === 'qualified' ? 'compatible' : item.support, check = parseCheck(item.check);
    if (check === undefined || support === 'compatible' && !accepted || item.available && support !== 'compatible'
      || item.available && check?.state === 'failed') return undefined;
    result[id] = { support, available: item.available, ...check ? { check } : {} };
  }
  return result;
}
