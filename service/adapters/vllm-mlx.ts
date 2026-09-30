import type { CapabilityDescriptor, CapabilityKey } from '../../src/contract/capabilities.ts';
import type { CatalogV2, Phase, RequestV2, RuntimeV2, StatusV2 } from '../../src/contract/snapshot.ts';
import { capabilitiesOf } from '../../src/contract/capabilities.ts';
import type { AdapterContextV2, AdapterReadingV2, AdapterV2, DescriptorV2, ReadContext, RuntimeReply } from '../core/adapter-v2.ts';
import { HINTS } from '../core/hints.ts';
import { HttpFailure } from '../http.ts';
import { count, modelLabel, nonneg, obj, type Json } from '../lib/parse.ts';

// vllm-mlx on the v2 contract (rewrite of the 1.6 VllmMlxClient). /v1/status is the reading; /health is optional metadata
// that only gates cache reuse and MLLM prefill ratios, so a missing or broken /health narrows those capabilities instead
// of blanking the runtime. Request ids stay in this file. Completions are left to the service's request watch.

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const name = (value: unknown): string | null => modelLabel(value);
const REUSE_KINDS = new Set(['hit', 'miss', 'miss_short_prefix', 'miss_short_lcp', 'exact', 'supersequence', 'prefix', 'lcp', 'ssd_hit']);
const OWNERS = ['vllm-mlx', 'vllm-mlx-embedding', 'vllm-mlx-reranker'];
export const HEALTH_EVERY_MS = 60_000;
/** Output that stopped advancing this long is not a live decode; a prefill ratio this long without progress is stale. */
export const DECODE_FRESH_MS = 5_000;
export const PREFILL_STALE_MS = 15_000;
const CONTINUITY_MS = 5_000;

const hint = HINTS.find(([id]) => id === 'vllm-mlx')![1];
/** `/health` as vllm-mlx shapes it (200, or 503 while its engine loads). */
export const isVllmHealth = ({ status, body }: Pick<RuntimeReply, 'status' | 'body'>): boolean => (status === 200 || status === 503) && body !== null
  && typeof body.model_loaded === 'boolean' && ['simple', 'batched', 'unknown'].includes(String(body.engine_type)) && Array.isArray(body.available_models);
/** `/v1/models` where every owner is vllm-mlx. */
export const isVllmModels = ({ status, body }: Pick<RuntimeReply, 'status' | 'body'>): boolean => {
  const owners = status === 200 && Array.isArray(body?.data) ? body.data.map(model => obj(model)?.owned_by ?? null) : [];
  return owners.includes('vllm-mlx') && owners.every(owner => OWNERS.includes(String(owner)));
};
/** `/v1/status` in one of its two documented shapes: a single model, or the model-manager registry. */
const statusShape = (body: Json | null): 'model' | 'registry' | null => {
  if (!body || !['running', 'stopped', 'not_loaded'].includes(String(body.status))) return null;
  const registry = obj(body.model_manager);
  return registry ? Array.isArray(registry.models) ? 'registry' : null : Object.hasOwn(body, 'model') && Array.isArray(body.requests) ? 'model' : null;
};

const R = 'reported' as const;
const declared = (keys: CapabilityKey[]): CapabilityDescriptor[] => keys.map(key => ({ key, basis: R }));
/** The most vllm-mlx can report; a reading narrows it to its mode. Context windows are never reported. */
const ALL = declared(['request.decodeRate', 'request.prefillProgress', 'request.tokens', 'request.elapsed', 'server.requests', 'server.averages',
  'server.cache', 'server.catalog']);

type Progress = { identity: string; phase: string; tokens: number | null; ratio: number | null; advancedAt: number | null; observedAt: number };
const READY: StatusV2 = { state: 'ready', reason: null, params: {} };

class VllmMlxAdapter implements AdapterV2 {
  private health: Json | null = null;
  private healthAt = Number.NEGATIVE_INFINITY;
  private healthModel: string | null = null;
  private progress: Progress | null = null;

  constructor(private readonly context: AdapterContextV2) {}

  async identity(): Promise<boolean> {
    const reply = await this.context.get('/v1/status');
    return reply.status === 200 && statusShape(reply.body) !== null;
  }

  dispose(): void { this.progress = null; }

  async read(_context: ReadContext): Promise<AdapterReadingV2> {
    let reply: RuntimeReply;
    // A dropped read loses continuity: the next output count cannot prove recent advancement.
    try { reply = await this.context.get('/v1/status'); } catch (error) { this.progress = null; throw error; }
    const at = this.context.now();
    if (reply.status === 401 || reply.status === 403) return this.unreadable(at, { state: 'failing', reason: 'authentication_failed', params: {} });
    // Another server on this port answers "no such route": the shape of a port swap, which re-detection settles.
    if (reply.status === 404 || reply.status === 405 || reply.routeMissing) return this.unreadable(at, { state: 'degraded', reason: 'unsupported_contract', params: {} });
    if (reply.status !== 200) { this.progress = null; throw new HttpFailure('runtime_unreachable', `The runtime returned HTTP ${reply.status}.`, reply.status); }
    const body = reply.body, shape = statusShape(body);
    if (!body || !shape) return this.unreadable(at, { state: 'degraded', reason: 'unsupported_contract', params: {} });
    if (shape === 'model') await this.refreshHealth(body, at);
    const runtime = shape === 'registry' ? this.registry(body) : this.model(body, at);
    if (shape === 'registry' || runtime.server.active === null) this.progress = null;
    return { at, status: READY, capabilities: capabilitiesOf(this.capabilities(shape, runtime)), runtime, identity: {}, completions: [] };
  }

  private unreadable(at: number, status: StatusV2): AdapterReadingV2 {
    this.progress = null;
    return { at, status, capabilities: {}, runtime: empty('unknown'), identity: {}, completions: [] };
  }

  /** Metadata for the loaded model, at most once a minute or when the model changes; any failure is "not known". */
  private async refreshHealth(status: Json, at: number): Promise<void> {
    if (at >= this.healthAt && at - this.healthAt < HEALTH_EVERY_MS && text(status.model) === this.healthModel) return;
    this.healthAt = at; this.healthModel = text(status.model);
    try {
      const reply = await this.context.get('/health');
      this.health = reply.status === 200 && isVllmHealth(reply) ? reply.body : null;
    } catch { this.health = null; }
  }

  /** Cache reuse and prefill ratios are trusted only for the exact engine /health describes. */
  private engine(model: unknown, engine: string, type: string): boolean {
    return this.health !== null && this.health.engine_type === engine && this.health.model_type === type && this.health.model_name === model;
  }

  private capabilities(shape: 'model' | 'registry', runtime: RuntimeV2): CapabilityDescriptor[] {
    if (shape === 'registry') return ALL.filter(item => item.key === 'server.catalog');
    if (runtime.server.active === null) return ALL.filter(item => item.key === 'server.catalog');
    // Without /health, prefill progress is not reportable at all (only batched MLLM engines report a ratio).
    return ALL.filter(item => item.key !== 'request.prefillProgress' || this.health !== null && this.health.engine_type === 'batched' && this.health.model_type === 'mllm')
      .filter(item => item.key !== 'server.averages' || runtime.server.averages !== undefined)
      .filter(item => item.key !== 'server.cache' || runtime.server.cache !== undefined);
  }

  private registry(body: Json): RuntimeV2 {
    const rows = obj(body.model_manager)!.models as unknown[];
    const catalog: CatalogV2[] = rows.slice(0, 12).flatMap(raw => {
      const item = obj(raw), label = name(item?.id);
      return label ? [{ name: label, loaded: typeof item?.loaded === 'boolean' ? item.loaded : null, format: 'mlx' as const, contextWindowTokens: null }] : [];
    });
    return { ...empty('unknown'), catalog };
  }

  private model(body: Json, at: number): RuntimeV2 {
    const model = name(body.model), residency = obj(body.residency)?.state;
    const loaded = body.status === 'not_loaded' ? false : body.status === 'running' ? true : null;
    const catalog: CatalogV2[] = model ? [{ name: model, loaded, format: 'mlx', contextWindowTokens: null }] : [];
    if (body.status === 'not_loaded') {
      return { ...empty(residency === 'loading' ? 'loading' : residency === 'unloading' ? 'processing' : 'not-loaded'), catalog };
    }
    if (body.status !== 'running') return { ...empty('unknown'), catalog };
    const active = count(body.num_running), queued = count(body.num_waiting);
    const cache = obj(body.cache), requestsTotal = count(body.total_requests_processed), uptime = nonneg(body.uptime_s);
    const server: RuntimeV2['server'] = { active, queued,
      ...requestsTotal !== null || uptime !== null ? { averages: { ...requestsTotal !== null ? { requestsTotal } : {}, ...uptime !== null ? { uptimeMs: uptime * 1000 } : {} } } : {},
      // MemoryAwarePrefixCache reports binary MB; a zero limit is the MLLM placeholder for "no cache".
      ...cache && (nonneg(cache.max_memory_mb) ?? 0) > 0 && nonneg(cache.current_memory_mb) !== null
        ? { cache: { ramBytes: Math.round(nonneg(cache.current_memory_mb)! * 1024 ** 2), ...count(cache.entry_count) !== null ? { ramEntries: count(cache.entry_count)! } : {} } } : {} };
    // Metal allocations are not an OS process footprint: process memory stays unreported.
    const base: RuntimeV2 = { ...empty('unknown'), server, catalog };
    const rows = Array.isArray(body.requests) ? body.requests : [];
    const running = rows.length <= 256 ? rows.map(obj).filter((row): row is Json => row !== null
      && row.status === 'running' && ['prefill', 'generation'].includes(String(row.phase))) : [];
    if (active === 0 && running.length === 0 && rows.length <= 256) {
      this.progress = null;
      return { ...base, phase: queued !== null && queued > 0 ? 'queued' : queued === 0 ? 'idle' : 'unknown' };
    }
    if (active !== 1 || running.length !== 1 || !text(running[0]?.request_id) || !text(body.model)) {
      this.progress = null;
      return { ...base, phase: 'processing' };
    }
    return { ...base, ...this.request(body, running[0]!, at) };
  }

  /** The one running request: output must be seen advancing before its speed is live, and a stalled prefill goes stale. */
  private request(status: Json, row: Json, at: number): Pick<RuntimeV2, 'phase' | 'request'> {
    const phase = String(row.phase), tokens = count(row.completion_tokens), prompt = count(row.prompt_tokens);
    const identity = JSON.stringify([status.model, row.request_id]), rawRatio = nonneg(row.progress);
    const ratio = phase === 'prefill' && tokens === 0 && this.engine(status.model, 'batched', 'mllm') && rawRatio !== null && rawRatio <= 1 ? rawRatio : null;
    const previous = this.progress;
    const transition = !previous || previous.identity !== identity || previous.phase !== phase || at < previous.observedAt
      || at - previous.observedAt > CONTINUITY_MS || tokens !== null && previous.tokens !== null && tokens < previous.tokens
      || ratio !== null && previous.ratio !== null && ratio < previous.ratio;
    if (transition) this.progress = { identity, phase, tokens, ratio, advancedAt: null, observedAt: at };
    else {
      const current = phase === 'prefill' ? ratio : tokens, before = phase === 'prefill' ? previous.ratio : previous.tokens;
      this.progress = { identity, phase, tokens, ratio, observedAt: at,
        advancedAt: current === null || before === null ? null : current > before ? at : previous.advancedAt };
    }
    const promptTokens = prompt !== null && prompt > 0 ? prompt : null, cached = count(row.cached_tokens);
    const cachedTokens = this.engine(status.model, 'batched', 'llm') && REUSE_KINDS.has(String(row.cache_hit_type))
      && cached !== null && promptTokens !== null && cached <= promptTokens ? cached : null;
    const elapsed = nonneg(row.elapsed_s), advancedAt = this.progress.advancedAt;
    const request: RequestV2 = { model: name(status.model), ...promptTokens !== null ? { promptTokens } : {}, ...cachedTokens !== null ? { cachedTokens } : {},
      ...tokens !== null ? { outputTokens: tokens } : {}, ...elapsed !== null ? { elapsedMs: elapsed * 1000 } : {} };
    if (phase === 'prefill') {
      // Only batched MLLM reports prefill ratios. Zero also means unavailable, and one may be unfinished work rounded up.
      const fraction = ratio !== null && ratio > 0 && ratio < 1 ? ratio : null;
      const stale = fraction !== null && (advancedAt === null || at - advancedAt >= PREFILL_STALE_MS);
      return { phase: 'prefill', request: { ...request, ...fraction !== null ? { prefillFraction: fraction } : {}, ...stale ? { prefillStale: true } : {} } };
    }
    const fresh = tokens !== null && tokens > 0 && advancedAt !== null && at - advancedAt <= DECODE_FRESH_MS;
    const tps = nonneg(row.tokens_per_second);
    return { phase: fresh ? 'decode' : 'processing', request: { ...request, ...fresh && tps !== null && tps > 0 ? { decodeTps: tps } : {} } };
  }
}

const empty = (phase: Phase): RuntimeV2 => ({ phase, request: null, server: { active: null, queued: null }, memory: {}, residency: [], slots: [], catalog: [], engines: [] });

export const vllmMlxDescriptor: DescriptorV2 = {
  id: 'vllm-mlx', hints: hint, identityEveryMs: 60_000, capabilities: ALL,
  detect: [
    { probe: '/health', confidence: 'medium', match: isVllmHealth },
    { probe: '/v1/models', confidence: 'high', match: isVllmModels },
  ],
  cadence: () => 450,
  create: context => new VllmMlxAdapter(context),
};
