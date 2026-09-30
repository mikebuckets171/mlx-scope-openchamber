import { capabilitiesOf, type CapabilityDescriptor } from '../../src/contract/capabilities.ts';
import { at as epoch, defined, list, obj, opt } from '../../src/contract/guards.ts';
import { LIMITS, type ResidencyV2, type RuntimeV2, type StatusV2 } from '../../src/contract/snapshot.ts';
import type { AdapterContextV2, AdapterReadingV2, AdapterV2, DescriptorV2, RuntimeReply } from '../core/adapter-v2.ts';
import { HttpFailure } from '../http.ts';
import { count, modelLabel, positive } from '../lib/parse.ts';

// Owner: ad-llama-ollama. /api/version (60 s) + /api/ps (5 s); residency only, no completions. size_vram is
// "GPU-resident (Ollama-reported)", never VRAM; expires_at → unloadsAt.

export const OLLAMA_VERSION_EVERY_MS = 60_000;
export const OLLAMA_PS_EVERY_MS = 5_000;
const MODELS_READ_MAX = 256;

/** `0.40.0`, `0.40.0-rc0`, or a source build's `0.0.0` (still Ollama, never "too old"). */
export const parseOllamaVersion = (body: unknown): string | null => {
  const version = obj(body)?.version;
  return typeof version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.-]{1,24})?$/.test(version) ? version : null;
};
/** Go `time.Time` JSON: RFC 3339 with up to nanoseconds and a Z or ±hh:mm offset. A zero or pre-1970 time is absent. */
export const rfc3339 = (value: unknown): number | null => {
  const match = typeof value === 'string' ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value) : null;
  return match ? epoch(Date.parse(`${match[1]}.${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}${match[3]}`)) : null;
};
const residency = (value: unknown): ResidencyV2 | null => {
  const item = obj(value), model = modelLabel(item?.name) ?? modelLabel(item?.model);
  // Allowlist: digest, details (parent_model is a path) and runner never leave this function.
  return item && model ? defined({
    model, phase: 'unknown' as const, source: 'ollama-ps' as const, bytes: opt(count(item.size)),
    gpuResidentBytes: opt(count(item.size_vram)), unloadsAt: opt(rfc3339(item.expires_at)), contextWindowTokens: opt(positive(item.context_length)),
  }) : null;
};
/** Every valid /api/ps row, in Ollama's order (latest expiry first); the adapter keeps 12 and counts the rest. */
export const parseOllamaPs = (body: unknown): ResidencyV2[] => list(obj(body)?.models, MODELS_READ_MAX, residency);
const isPs = (reply: RuntimeReply | null): boolean => reply !== null && reply.status === 200 && !reply.routeMissing && Array.isArray(obj(reply.body)?.models);

/** A GET whose HTTP failure becomes its status; a network failure still throws (the slot's `failing`). */
const settle = async (request: () => Promise<RuntimeReply>): Promise<RuntimeReply> => {
  try { return await request(); } catch (error) {
    if (error instanceof HttpFailure && error.status !== null) return { status: error.status, body: null, routeMissing: false };
    throw error;
  }
};
const authenticate = (status: number): void => {
  if (status === 401 || status === 403) throw new HttpFailure('authentication_failed', 'Ollama rejected the request key.', status);
};
const UNSUPPORTED: StatusV2 = { state: 'degraded', reason: 'unsupported_contract', params: {} };
/** Null rows: nothing was read. Ollama reports residency only, so a loaded model's phase stays unknown and requests cannot be counted. */
const runtimeOf = (rows: readonly ResidencyV2[] | null): RuntimeV2 => ({
  phase: rows?.length === 0 ? 'not-loaded' : 'unknown', request: null, server: { active: null, queued: null }, memory: {},
  residency: rows?.slice(0, LIMITS.residency) ?? [], ...rows ? { residencyCount: rows.length } : {}, slots: [], catalog: [], engines: [],
});
export const OLLAMA_CAPABILITIES: readonly CapabilityDescriptor[] = [{ key: 'server.residency', basis: 'reported' }];

class OllamaAdapter implements AdapterV2 {
  private version: string | null = null;
  private versionAt = -Infinity;
  constructor(private readonly context: AdapterContextV2) {}

  /** /api/version at most every 60 s; false when the answer is not Ollama's. */
  private async loadVersion(): Promise<boolean> {
    const mono = this.context.monotonic();
    if (mono - this.versionAt < OLLAMA_VERSION_EVERY_MS) return this.version !== null;
    const reply = await settle(() => this.context.get('/api/version'));
    authenticate(reply.status);
    // A 5xx keeps a known version; with none yet the runtime cannot be read at all.
    if (reply.status >= 500 && this.version !== null) return true;
    if (reply.status >= 500) throw new HttpFailure('runtime_unreachable', `Ollama /api/version answered HTTP ${reply.status}.`, reply.status);
    this.versionAt = mono;
    this.version = reply.routeMissing ? null : parseOllamaVersion(reply.body);
    return this.version !== null;
  }

  async read(): Promise<AdapterReadingV2> {
    const at = this.context.now();
    const known = await this.loadVersion();
    const reading = (status: StatusV2, runtime: RuntimeV2, capabilities: readonly CapabilityDescriptor[] = []): AdapterReadingV2 =>
      ({ at, status, capabilities: capabilitiesOf(capabilities), runtime, identity: this.version ? { version: this.version } : {}, completions: [] });
    if (!known) return reading(UNSUPPORTED, runtimeOf(null));
    const ps = await settle(() => this.context.get('/api/ps'));
    authenticate(ps.status);
    // Error bodies carry free text (paths): only the status is kept.
    if (ps.status >= 500) throw new HttpFailure('runtime_unreachable', `Ollama /api/ps answered HTTP ${ps.status}.`, ps.status);
    if (!isPs(ps)) return reading(UNSUPPORTED, runtimeOf(null));
    return reading({ state: 'ready', reason: null, params: {} }, runtimeOf(parseOllamaPs(ps.body)), OLLAMA_CAPABILITIES);
  }

  /** Still Ollama: the same /api/version read, never more than every 60 s. */
  async identity(): Promise<boolean> { return this.loadVersion(); }
  dispose(): void { this.version = null; }
}

export const ollamaDescriptor: DescriptorV2 = {
  id: 'ollama', hints: (id, name) => /ollama/i.test(`${id} ${name}`),
  detect: [{
    probe: '/api/version', confidence: 'high',
    // Plan §5.1 order 3: /api/version, then Ollama's own /api/ps.
    match: async (reply, follow) => reply.status === 200 && !reply.routeMissing && parseOllamaVersion(reply.body) !== null
      && isPs(await follow('/api/ps').catch(() => null)),
  }],
  cadence: () => OLLAMA_PS_EVERY_MS, capabilities: OLLAMA_CAPABILITIES, identityEveryMs: 60_000,
  create: context => new OllamaAdapter(context),
};
