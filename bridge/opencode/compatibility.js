// Upstream qualification, Scope's wire format, and the companion package version are independent.
// Keep the legacy protocol spelling so an updated helper still interoperates with existing readers.
export const CHAT_PROTOCOL = 'opencode-2.0.25';
export const TELEMETRY_SCHEMA_VERSION = 1;
export const FEATURE_IDS = ['http-delivery', 'websocket-delivery', 'prompt-progress', 'managed-reload'];
const profiles = ['2.0.25', '2.0.27', '2.0.28'].map(runtimeVersion => Object.freeze({
  id: `opencode-${runtimeVersion}-v1`, runtimeVersion, protocol: CHAT_PROTOCOL,
  websocketCancellation: runtimeVersion === '2.0.25' ? 'unit-only' : 'native',
}));

/** Matching APIs alone do not qualify event ordering, token semantics, or a transport path. */
export const profileFor = runtimeVersion => profiles.find(profile => runtimeVersion === profile.runtimeVersion) ?? null;
export const acceptsChatProtocol = (runtimeVersion, protocol) => !!profileFor(runtimeVersion) && protocol === CHAT_PROTOCOL;
export const featureSupport = runtimeVersion => Object.fromEntries(FEATURE_IDS.map(id =>
  [id, { support: profileFor(runtimeVersion) ? 'qualified' : 'unqualified', available: false }]));

/** Optional heartbeat extension. Ignore unknown features and reject contradictory claims. */
export function parseFeatures(value, runtimeVersion) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = featureSupport(runtimeVersion);
  for (const id of FEATURE_IDS) {
    const item = value[id];
    if (!item || typeof item !== 'object' || !['qualified', 'unqualified', 'unavailable'].includes(item.support)
      || typeof item.available !== 'boolean' || item.support === 'qualified' && !profileFor(runtimeVersion)
      || item.available && item.support !== 'qualified') return undefined;
    result[id] = { support: item.support, available: item.available };
  }
  return result;
}
