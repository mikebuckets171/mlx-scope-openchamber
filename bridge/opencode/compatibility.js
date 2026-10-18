// Upstream support, Scope's wire format, and the companion package version are independent.
// Keep the legacy protocol spelling so an updated helper still interoperates with existing readers.
export const CHAT_PROTOCOL = 'opencode-2.0.25';
export const TELEMETRY_SCHEMA_VERSION = 1;
export const FEATURE_IDS = ['http-delivery', 'websocket-delivery', 'prompt-progress', 'managed-reload'];
/** Why a running check withdrew a feature. Codes only; never paths, messages or event contents. */
export const CHECK_REASONS = ['hook-missing', 'hook-rejected', 'events-missing', 'event-shape', 'session-header', 'options'];
const CHECK_STATES = ['waiting', 'passed', 'failed'];

/**
 * OpenCode 2.0.25 introduced the public plugin and event contract this helper reads, and later 2.0 patches have kept it.
 * Patch releases on that line are accepted and checked while they run; a new minor or major is a different contract.
 * Which versions were natively qualified is the service's record (qualified.js), so qualifying one never changes these bytes.
 */
export const acceptsRuntime = runtimeVersion => {
  const match = typeof runtimeVersion === 'string' && /^2\.0\.(0|[1-9]\d{0,3})$/.exec(runtimeVersion);
  return !!match && Number(match[1]) >= 25;
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
