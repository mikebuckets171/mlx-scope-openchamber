import { unavailableTelemetry, type AvailableTelemetry, type TelemetrySnapshot } from '../src/telemetry.ts';
import type { CatalogModel } from '../src/runtime.ts';
import type { RuntimeRead } from './adapter.ts';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = (value: unknown): number | null => { const n = number(value); return n !== null && Number.isSafeInteger(n) ? n : null; };
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const name = (value: unknown): string | null => {
  const clean = text(value)?.replace(/[\u0000-\u001f\u007f]/g, '');
  if (!clean) return null;
  return (/^(?:[\\/]|\.{1,2}[\\/]|~[\\/]|file:|[A-Za-z]:[\\/])/.test(clean)
    ? clean.split(/[\\/]/).filter(Boolean).at(-1) : clean)?.slice(0, 160) || null;
};
const reuseKinds = new Set(['hit', 'miss', 'miss_short_prefix', 'miss_short_lcp', 'exact', 'supersequence', 'prefix', 'lcp', 'ssd_hit']);
type Progress = { identity: string; phase: string; tokens: number | null; ratio: number | null; advancedAt: number | null; observedAt: number };

/** Read the documented status endpoint; request identities remain service-local. */
export class VllmMlxClient {
  private health: ObjectValue | null = null;
  private healthAt = Number.NEGATIVE_INFINITY;
  private healthModel: string | null = null;
  private progress: Progress | null = null;
  private epoch = 0;

  constructor(private readonly read: RuntimeRead, private readonly now: () => number = Date.now) {}

  private reset(): void { this.progress = null; this.epoch++; }

  async snapshot(): Promise<TelemetrySnapshot> {
    try { return await this.collect(); }
    catch (error) { this.reset(); throw error; }
  }

  private async collect(): Promise<TelemetrySnapshot> {
    const status = await this.read('/v1/status');
    const sampledAt = this.now();
    const registry = object(status?.model_manager);
    const supportedShape = status !== null && (registry ? Array.isArray(registry.models)
      : Object.hasOwn(status, 'model') && Array.isArray(status.requests));
    if (!status || !supportedShape || !['running', 'stopped', 'not_loaded'].includes(String(status.status))) {
      this.reset();
      return unavailableTelemetry('unsupported_contract', 'vllm-mlx returned an unsupported status response.', sampledAt);
    }
    if (sampledAt < this.healthAt || sampledAt - this.healthAt >= 60_000 || text(status.model) !== this.healthModel) {
      this.health = await this.read('/health');
      this.healthAt = sampledAt;
      this.healthModel = text(status.model);
    }
    const base: AvailableTelemetry = {
      ...unavailableTelemetry('unsupported_contract', null, sampledAt),
      available: true, reason: null, runtime: 'vllm-mlx', phase: 'unknown',
    };
    if (registry) {
      this.reset();
      const rows = Array.isArray(registry.models) ? registry.models : [];
      const catalog: CatalogModel[] = rows.slice(0, 12).flatMap(raw => {
        const item = object(raw), label = name(item?.id);
        return label ? [{ name: label, loaded: typeof item?.loaded === 'boolean' ? item.loaded : null,
          format: 'mlx', contextWindow: null }] : [];
      });
      return { ...base, catalog, message: 'Model registry connected · this endpoint does not expose per-model request readings.' };
    }
    const modelID = name(status.model);
    const residency = object(status.residency);
    const loading = residency?.state === 'loading' || residency?.state === 'unloading';
    const loaded = status.status === 'not_loaded' ? false : status.status === 'running' ? true : null;
    base.modelID = modelID;
    base.catalog = modelID ? [{ name: modelID, loaded, format: 'mlx', contextWindow: null }] : [];
    if (status.status === 'not_loaded') {
      this.reset();
      return { ...base, phase: loading ? 'processing' : 'notLoaded',
        message: residency?.state === 'loading' ? 'Loading the model · token progress unavailable'
          : residency?.state === 'unloading' ? 'Unloading the model' : residency?.state === 'failed' ? 'The model could not be loaded.' : null };
    }
    if (status.status !== 'running') {
      this.reset();
      return { ...base, message: 'The vllm-mlx engine is stopped.' };
    }
    const active = count(status.num_running), queued = count(status.num_waiting);
    base.activeRequests = active;
    base.queuedRequests = queued;
    base.sessionStatsState = 'fresh';
    base.lifetime = {
      requestsTotal: count(status.total_requests_processed), promptTokensTotal: count(status.total_prompt_tokens),
      completionTokensTotal: count(status.total_completion_tokens), cachedTokensTotal: null, uptimeSeconds: number(status.uptime_s),
    };
    const cache = object(status.cache);
    // These fields come from MemoryAwarePrefixCache. A zero limit is the MLLM placeholder for no cache.
    if (cache && (number(cache.max_memory_mb) ?? 0) > 0 && number(cache.current_memory_mb) !== null) {
      base.sessionBank = { hot: { totalGB: number(cache.current_memory_mb)! * 1024 ** 2 / 1e9,
        entries: count(cache.entry_count) }, cold: null, lastMissReason: null };
    }
    // Metal allocations are not an OS process footprint. The process memory fields stay unavailable.
    const rows = Array.isArray(status.requests) ? status.requests : [];
    const canonical = rows.length <= 256 ? rows.map(object).filter((row): row is ObjectValue => row !== null
      && row.status === 'running' && ['prefill', 'generation'].includes(String(row.phase))) : [];
    if (active === 0 && canonical.length === 0 && rows.length <= 256) {
      this.reset();
      return { ...base, phase: queued !== null && queued > 0 ? 'queued' : queued === 0 ? 'idle' : 'unknown' };
    }
    if (active !== 1 || canonical.length !== 1 || !text(canonical[0]?.request_id) || !text(status.model)) {
      this.reset();
      return { ...base, phase: 'processing', message: active !== null && active > 1
        ? 'Concurrent requests · per-request readings withheld' : 'Runtime active · detailed request readings unavailable' };
    }
    const request = canonical[0]!;
    const phase = String(request.phase);
    const tokens = count(request.completion_tokens);
    const prompt = count(request.prompt_tokens);
    const identity = JSON.stringify([status.model, request.request_id]);
    const rawRatio = number(request.progress);
    const ratio = phase === 'prefill' && tokens === 0 && this.health?.engine_type === 'batched' && this.health.model_type === 'mllm'
      && this.health.model_name === status.model && rawRatio !== null && rawRatio >= 0 && rawRatio <= 1 ? rawRatio : null;
    const previous = this.progress;
    const transition = !previous || previous.identity !== identity || previous.phase !== phase
      || sampledAt < previous.observedAt || sampledAt - previous.observedAt > 5_000
      || tokens !== null && previous.tokens !== null && tokens < previous.tokens
      || ratio !== null && previous.ratio !== null && ratio < previous.ratio;
    if (transition) {
      this.epoch++;
      this.progress = { identity, phase, tokens, ratio, advancedAt: null, observedAt: sampledAt };
    } else {
      const currentValue = phase === 'prefill' ? ratio : tokens;
      const previousValue = phase === 'prefill' ? previous.ratio : previous.tokens;
      this.progress = { identity, phase, tokens, ratio,
        advancedAt: currentValue === null || previousValue === null ? null
          : currentValue > previousValue ? sampledAt : previous.advancedAt,
        observedAt: sampledAt };
    }
    base.traceEpoch = this.epoch;
    base.promptTokens = prompt !== null && prompt > 0 ? prompt : null;
    const cached = count(request.cached_tokens);
    base.cachedTokens = this.health?.engine_type === 'batched' && this.health.model_type === 'llm'
      && this.health.model_name === status.model
      && reuseKinds.has(String(request.cache_hit_type)) && cached !== null && base.promptTokens !== null && cached <= base.promptTokens ? cached : null;
    base.completionTokens = tokens;
    base.elapsedSeconds = number(request.elapsed_s);
    if (phase === 'prefill') {
      // Only batched MLLM reports prefill ratios. Zero also means unavailable;
      // one may be unfinished work rounded up by the runtime. Neither is a precise percentage.
      const progress = ratio !== null && ratio > 0 && ratio < 1 ? ratio : null;
      const advancedAt = this.progress!.advancedAt;
      const stale = progress !== null && (advancedAt === null || sampledAt - advancedAt >= 15_000);
      return { ...base, phase: 'prefill', prefillProgress: progress, prefillProgressStale: stale,
        message: stale ? 'Prefill is active · waiting for fresh progress'
          : progress === null ? 'Processing input · this engine does not report precise prefill progress' : 'Reported prefill progress · processed token counts and estimate unavailable' };
    }
    const advancedAt = this.progress!.advancedAt;
    const fresh = tokens !== null && tokens > 0 && advancedAt !== null && sampledAt - advancedAt <= 5_000;
    return { ...base, phase: fresh ? 'decode' : 'processing',
      liveDecodeTPS: fresh && (number(request.tokens_per_second) ?? 0) > 0 ? number(request.tokens_per_second) : null,
      message: fresh ? null : tokens !== null && tokens > 0 ? 'Waiting for fresh output counters' : 'Waiting for the first output token' };
  }
}
