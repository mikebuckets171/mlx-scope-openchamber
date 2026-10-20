// Upstream support, Scope's wire format, and the companion package version are independent.
// Keep the legacy protocol spelling so an updated helper still interoperates with existing readers.
export const CHAT_PROTOCOL = 'opencode-2.0.25';
export const TELEMETRY_SCHEMA_VERSION = 1;
export const FEATURE_IDS = ['http-delivery', 'websocket-delivery', 'prompt-progress', 'managed-reload'];
/** Why a running check withdrew a feature. Codes only; never paths, messages or event contents. */
export const CHECK_REASONS = ['hook-missing', 'hook-rejected', 'events-missing', 'event-shape', 'session-header', 'options'];
const CHECK_STATES = ['waiting', 'passed', 'failed'];

/** First patch of each accepted line whose released contract this helper reads: 2.0.25, and 2.1.1. */
const LINES = new Map([['0', 25], ['1', 1]]);
/**
 * Locally built runtimes report a suffixed version, which no rule can bound. Only reviewed identifiers are listed,
 * never a pattern: an unreviewed build stays unsupported, exactly as an unrecognised release line does.
 */
export const REVIEWED_BUILDS = ['2.1.1-compaction.1'];
/**
 * OpenCode 2.0.25 introduced the public plugin and event contract this helper reads; the 2.1 line keeps it. Compared
 * tag to tag (v2.0.32 → v2.1.1), every consumed name and field is unchanged: the session hook names and request kinds,
 * the `x-opencode-session-id` request header, the event envelope, and the session events and usage figures read here.
 * 2.1 changed how a compaction stores what it keeps — `metadata.keepID` plus the `metadata.recent` that
 * `session.context` materializes, where 2.0 stored the recent text on the event — and renamed optional `providerState`
 * to `native`. Neither field is read here; `session.compaction.started` is used only as a reset signal. Two new events
 * (`session.archived`, `session.unarchived`) are outside every rule this helper applies.
 * Which versions were natively qualified is the service's record (qualified.js), so qualifying one never changes these bytes.
 */
export const acceptsRuntime = runtimeVersion => {
  if (typeof runtimeVersion !== 'string') return false;
  if (REVIEWED_BUILDS.includes(runtimeVersion)) return true;
  const match = /^2\.(\d+)\.(0|[1-9]\d{0,3})$/.exec(runtimeVersion);
  return !!match && Number(match[2]) >= (LINES.get(match[1]) ?? Infinity);
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
