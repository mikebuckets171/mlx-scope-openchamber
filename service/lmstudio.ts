import { unavailableTelemetry, type ResidentModel, type TelemetrySnapshot } from '../src/telemetry.ts';
import type { CatalogModel } from '../src/runtime.ts';
import type { RuntimeRead } from './adapter.ts';
import { HttpFailure } from './http.ts';
import type { LMStudioActivityView } from './lmstudio-activity.ts';

type ActivitySource = { touch(): void; view(): LMStudioActivityView | null };
const rateText = (value: number | null): string | null => value === null ? null : `${value.toFixed(1)} tok/s`;

const DISPLAY_LIMIT = 12;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const contextLength = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
const format = (value: unknown): CatalogModel['format'] => value === 'mlx' || value === 'gguf' ? value : null;
const modelName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  let name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (/^(?:[\\/]|[a-z]:[\\/]|~[\\/]|[a-z][a-z0-9+.-]*:\/\/)/i.test(name)) {
    name = name.replace(/[?#].*$/, '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').at(-1) ?? '';
  }
  return name ? name.slice(0, 160) : null;
};
const resident = (id: string): ResidentModel => ({
  id, phase: 'unknown', activeRequests: null, queuedRequests: null, allocationGB: null,
  tokensPerSecond: null, prefillProgress: null, progressStale: false,
});

/**
 * Reads model inventory from LM Studio's REST API. When a local log-stream source is healthy, live request
 * phase and exact per-request completion figures come from LM Studio's redacted server log.
 */
export class LMStudioClient {
  private legacy = false;
  constructor(private readonly read: RuntimeRead, private readonly now: () => number = Date.now,
    private readonly activity: ActivitySource | null = null) {}

  async snapshot(): Promise<TelemetrySnapshot> {
    this.activity?.touch();
    let body: Record<string, unknown> | null;
    try { body = await this.read(this.legacy ? '/api/v0/models' : '/api/v1/models'); }
    catch (error) {
      if (this.legacy || !(error instanceof HttpFailure) || error.status !== 404) throw error;
      this.legacy = true;
      body = await this.read('/api/v0/models');
    }
    const rows = this.legacy ? body?.data : body?.models;
    const unsupported = (): TelemetrySnapshot => ({
      ...unavailableTelemetry('unsupported_contract', 'LM Studio returned an unsupported model inventory.', this.now()),
      runtime: 'lmstudio',
    });
    if (!Array.isArray(rows) || this.legacy && body?.object !== 'list') return unsupported();
    const catalog: CatalogModel[] = [];
    const residentModels: ResidentModel[] = [];
    let loadedCount = 0;
    let countKnown = true;
    let validModels = 0;
    for (const raw of rows) {
      const item = object(raw);
      const name = modelName(this.legacy ? item?.id : item?.key);
      const validType = this.legacy ? ['llm', 'vlm', 'embeddings'].includes(String(item?.type)) : item?.type === 'llm' || item?.type === 'embedding';
      if (!item || !name || !validType) { countKnown = false; continue; }
      validModels += 1;
      let loaded: boolean | null = null;
      let contextWindow: number | null = null;
      if (this.legacy) {
        loaded = item.state === 'loaded' ? true : item.state === 'not-loaded' ? false : null;
        contextWindow = contextLength(item.max_context_length);
        if (loaded) {
          loadedCount += 1;
          if (residentModels.length < DISPLAY_LIMIT) residentModels.push(resident(name));
        } else if (loaded === null) countKnown = false;
      } else if (Array.isArray(item.loaded_instances)) {
        const contexts = new Set<number>();
        let contextsKnown = true;
        let modelLoadedCount = 0;
        for (const rawInstance of item.loaded_instances) {
          const instance = object(rawInstance), id = modelName(instance?.id);
          if (!instance || !id) { countKnown = false; contextsKnown = false; continue; }
          modelLoadedCount += 1;
          loadedCount += 1;
          if (residentModels.length < DISPLAY_LIMIT) residentModels.push(resident(id));
          const length = contextLength(object(instance.config)?.context_length);
          if (length === null) contextsKnown = false;
          else contexts.add(length);
        }
        loaded = modelLoadedCount > 0 ? true : item.loaded_instances.length === 0 ? false : null;
        contextWindow = loaded === false ? contextLength(item.max_context_length)
          : contextsKnown && contexts.size === 1 ? contexts.values().next().value ?? null : null;
      } else countKnown = false;
      if (catalog.length < DISPLAY_LIMIT) catalog.push({ name, loaded, format: format(this.legacy ? item.compatibility_type : item.format), contextWindow });
    }
    if (rows.length > 0 && validModels === 0) return unsupported();
    const inventory: TelemetrySnapshot = {
      ...unavailableTelemetry('unsupported_contract', null, this.now()),
      available: true, reason: null, runtime: 'lmstudio', phase: 'unknown',
      modelID: residentModels[0]?.id ?? null,
      message: 'Model inventory is available. Live prefill and generation are not reported by this API.',
      catalog, residentModels, residentModelCount: countKnown ? loadedCount : null,
    };
    const view = this.activity?.view() ?? null;
    return view ? this.withActivity(inventory, view, countKnown ? loadedCount : null) : inventory;
  }

  private withActivity(inventory: TelemetrySnapshot, view: LMStudioActivityView, loadedCount: number | null): TelemetrySnapshot {
    const now = this.now();
    const active = view.active;
    const last = view.lastRequest;
    const phase = active ? active.phase : loadedCount === null ? 'unknown' : loadedCount > 0 ? 'idle' : 'notLoaded';
    const lastSummary = last ? [
      rateText(last.tokensPerSecond), last.outputTokens === null ? null : `${last.outputTokens.toLocaleString('en-US')} output tokens`,
      last.ttftSeconds === null ? null : `first token ${last.ttftSeconds.toFixed(1)}s`,
    ].filter(Boolean).join(' · ') : null;
    const message = active
      ? active.phase === 'prefill'
        ? `Reading the prompt on ${active.model}${active.progress !== null ? ` · ${Math.round(active.progress * 100)}%` : ''}.`
        : `Generating on ${active.model}. LM Studio reports exact speed when the response finishes${last?.tokensPerSecond != null ? ` (last: ${rateText(last.tokensPerSecond)})` : ''}.`
      : lastSummary ? `Last response: ${lastSummary}.` : phase === 'idle' ? 'Model loaded. Ready for your next request.' : inventory.message;
    const residentModels = inventory.residentModels.map(model => active && model.id === active.model
      ? { ...model, phase: active.phase, activeRequests: active.requests, prefillProgress: active.phase === 'prefill' ? active.progress : null } : model);
    return {
      ...inventory,
      phase,
      modelID: active?.model ?? last?.model ?? inventory.modelID,
      message,
      prefillProgress: active?.phase === 'prefill' ? active.progress : null,
      elapsedSeconds: active ? Math.max(0, (now - active.startedAt) / 1000) : null,
      activeRequests: view.activeRequests,
      sessionStatsState: view.completedRequests > 0 ? 'fresh' : 'unavailable',
      sessionAverageDecodeTPS: view.averageDecodeTPS,
      sessionCacheEfficiencyPercent: view.cacheEfficiencyPercent,
      lastRequest: last,
      residentModels,
    };
  }
}
