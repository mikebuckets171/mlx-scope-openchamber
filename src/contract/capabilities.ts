import { obj, oneOf } from './guards.ts';

export const BASES = ['reported', 'derived', 'observed', 'last-observed', 'estimate'] as const;
/** How a value came to be (contract §4). Anything not `reported` carries its basis label in the UI (P3). */
export type Basis = typeof BASES[number];
export const CAPABILITY_SCOPES = ['request', 'server', 'host'] as const;
export type CapabilityScope = typeof CAPABILITY_SCOPES[number];
export interface Capability { scope: CapabilityScope; basis: Basis }

export const CAPABILITY_KEYS = [
  'request.decodeRate', 'request.prefillRate', 'request.prefillProgress', 'request.prefillEta',
  'request.ttft', 'request.tokens', 'request.elapsed', 'request.context',
  'server.requests', 'server.averages', 'server.latency', 'server.cache',
  'server.memory.process', 'server.memory.model', 'server.memory.metal', 'server.memory.ceiling',
  'server.residency', 'server.slots', 'server.rates', 'server.speculative', 'server.catalog', 'server.engines',
  'server.usage', 'server.completions',
  'host.cpu', 'host.memory', 'host.swap', 'host.pressure', 'host.wiredLimit',
  'host.gpuBusy', 'host.gpuMemory', 'host.thermal', 'host.footprint', 'host.power',
] as const;
export type CapabilityKey = typeof CAPABILITY_KEYS[number];
/** Absent key = not reportable on this connection. The panel shows nothing for it: no dash, no zero. */
export type Capabilities = Partial<Record<CapabilityKey, Capability>>;
/** What an adapter declares it can report, and how (registry descriptors list these). */
export interface CapabilityDescriptor { key: CapabilityKey; basis: Basis }

export const basis = oneOf(BASES);
export const capabilityKey = oneOf(CAPABILITY_KEYS);
export const capabilityScope = (key: CapabilityKey): CapabilityScope => key.slice(0, key.indexOf('.')) as CapabilityScope;
export const capabilitiesOf = (descriptors: Iterable<CapabilityDescriptor>): Capabilities => {
  const result: Capabilities = {};
  for (const { key, basis } of descriptors) result[key] = { scope: capabilityScope(key), basis };
  return result;
};

/** Unknown keys, a scope that disagrees with the key, or an unknown basis drop that entry. */
export const parseCapabilities = (value: unknown): Capabilities => {
  const result: Capabilities = {};
  for (const [raw, entry] of Object.entries(obj(value) ?? {})) {
    const key = capabilityKey(raw), item = obj(entry), kind = basis(item?.basis);
    if (key && kind && item?.scope === capabilityScope(key)) result[key] = { scope: capabilityScope(key), basis: kind };
  }
  return result;
};
