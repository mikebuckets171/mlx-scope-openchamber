import { count as tokenCount, modelLabel, nonneg as nonnegative, obj as asObject } from '../../src/contract/guards.ts';
import { percentToFraction, secondsToMs } from '../../src/contract/units.ts';

// Moved from src/telemetry.ts:272-657 (the 1.6 oMLX normalizer), verbatim apart from unit renames: decimal GB becomes
// integer bytes, seconds become ms, the cache percent a fraction. Its honesty logic is frozen (plan §10). The 1.6
// copy stays in src/telemetry.ts until the registry serves oMLX through ./omlx.ts (svc-2b).
//
// Under G1 (SPIKES S6) the session totals come from `/api/status`, never `/admin/api/stats`. `runtime_cache` (the
// request-matched prefix lookup, the session bank) is still read if a session body carries one; `/api/status` has none.

type JsonObject = { readonly [key: string]: unknown };
export type OmlxPhase = 'notLoaded' | 'idle' | 'queued' | 'prefill' | 'decode' | 'processing' | 'unknown';
export type OmlxStatsState = 'fresh' | 'stale' | 'unavailable';

export interface OmlxMemory { activeBytes: number | null; peakBytes: number | null; modelBytes: number | null; cacheBytes: number | null }
export interface OmlxCacheTier { totalBytes: number | null; entries: number | null }
export interface OmlxSessionBank { hot: OmlxCacheTier | null; cold: OmlxCacheTier | null; lastMissReason: string | null }
export interface OmlxLifetime {
  requestsTotal: number | null; promptTokensTotal: number | null; completionTokensTotal: number | null; cachedTokensTotal: number | null;
  uptimeMs: number | null;
}
export interface OmlxResident {
  id: string; phase: OmlxPhase; activeRequests: number | null; queuedRequests: number | null; allocationBytes: number | null;
  tokensPerSecond: number | null; prefillProgress: number | null; progressStale: boolean;
  loading: boolean;                          // is_loading, so the v2 mapping can name the phase
  contextWindow: number | null;              // /v1/models/status for this row's id
}
export interface OmlxNormalized {
  message: string | null;                    // 1.6 English; never on the v2 wire
  modelID: string | null;
  loading: boolean;                          // the headline model is still loading
  phase: OmlxPhase;
  sessionStatsState: OmlxStatsState;
  sessionAveragePrefillTPS: number | null;
  liveDecodeTPS: number | null;
  livePrefillTPS: number | null;
  sessionAverageDecodeTPS: number | null;
  sessionCacheEfficiencyFraction: number | null;
  promptTokens: number | null;
  cachedTokens: number | null;
  completionTokens: number | null;
  prefillProgress: number | null;
  prefillProcessedTokens: number | null;
  prefillTotalTokens: number | null;
  prefillProgressStale: boolean;
  prefillEtaMs: number | null;
  elapsedMs: number | null;
  activeRequests: number | null;
  queuedRequests: number | null;
  contextWindow: number | null;
  memory: OmlxMemory;
  sessionBank: OmlxSessionBank | null;
  lifetime: OmlxLifetime | null;
  memoryPressureLevel: number | null;        // the oMLX process memory guard 1–3, not macOS pressure
  sampledAt: number;
  residentModels: OmlxResident[];
  residentModelCount: number | null;
}
export const MAX_RESIDENT_MODELS = 12;

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};
const firstNumber = (...values: unknown[]): number | null => {
  for (const value of values) {
    const number = nonnegative(value);
    if (number !== null) return number;
  }
  return null;
};

const firstTokenCount = (...values: unknown[]): number | null => {
  for (const value of values) {
    const count = tokenCount(value);
    if (count !== null) return count;
  }
  return null;
};

const cacheLookupReason = (value: unknown): string | null => (
  typeof value === 'string' && ['empty_prompt', 'no_recent_store_probe', 'closest_recent_store'].includes(value)
    ? value : null
);

/** Was `gb`: the same reading as integer bytes (the 1.x value × 1e9, rounded, as `gbToBytes` recovers it). */
const bytes = (value: unknown): number | null => {
  const number = nonnegative(value);
  return number === null || !Number.isSafeInteger(Math.round(number)) ? null : Math.round(number);
};
const ms = (value: unknown): number | null => secondsToMs(nonnegative(value));

const arrayOfObjects = (value: unknown): JsonObject[] => (
  Array.isArray(value) ? value.map(asObject).filter((item): item is JsonObject => item !== null) : []
);

const matchingModel = (models: JsonObject[], preferredModel: string | null): JsonObject | null => (
  models.find((model) => Array.isArray(model.generating) && model.generating.length > 0)
    ?? models.find((model) => Array.isArray(model.prefilling) && model.prefilling.length > 0)
    ?? models.find((model) => (nonnegative(model.active_requests) ?? 0) > 0)
    ?? models.find((model) => arrayOfObjects(model.activities).length > 0)
    ?? models.find((model) => model.is_loading === true)
    ?? (preferredModel === null ? undefined : models.find((model) => model.id === preferredModel))
    ?? models[0]
    ?? null
);

type FlightSummary = {
  phase: OmlxPhase;
  message: string | null;
  liveDecodeTPS: number | null;
  livePrefillTPS: number | null;
  promptTokens: number | null;
  cachedTokens: number | null;
  completionTokens: number | null;
  prefillProgress: number | null;
  prefillProcessedTokens: number | null;
  prefillTotalTokens: number | null;
  prefillProgressStale: boolean;
  prefillEtaMs: number | null;
  elapsedMs: number | null;
};

const EMPTY_FLIGHT: Omit<FlightSummary, 'phase' | 'message'> = {
  liveDecodeTPS: null,
  livePrefillTPS: null,
  promptTokens: null,
  cachedTokens: null,
  completionTokens: null,
  prefillProgress: null,
  prefillProcessedTokens: null,
  prefillTotalTokens: null,
  prefillProgressStale: false,
  prefillEtaMs: null,
  elapsedMs: null,
};

const normalizeFlights = (model: JsonObject | null, lookup: JsonObject, ambiguous = false): FlightSummary => {
  if (model === null) return { phase: 'idle', message: null, ...EMPTY_FLIGHT };

  const hasStateEvidence = [
    'active_requests',
    'waiting_requests',
    'prefilling',
    'generating',
    'waiting',
    'activities',
    'is_loading',
  ].some((key) => Object.prototype.hasOwnProperty.call(model, key));
  if (!hasStateEvidence) {
    return { phase: 'unknown', message: 'Model state unavailable · waiting for a complete runtime sample', ...EMPTY_FLIGHT };
  }

  let summary: FlightSummary = {
    phase: model.is_loading === true ? 'processing' : 'idle',
    message: model.is_loading === true ? 'Loading the model · no token speed yet' : null,
    ...EMPTY_FLIGHT,
  };
  if (asObject(model.cluster) !== null) {
    const working = (nonnegative(model.active_requests) ?? 0) > 0
      || ['prefilling', 'generating', 'activities'].some((key) => arrayOfObjects(model[key]).length > 0);
    // Distributed rows reuse a synthetic rank ID rather than a request identity.
    return { ...summary, phase: working ? 'processing' : summary.phase,
      message: 'Distributed model · request-level telemetry unavailable' };
  }
  if (ambiguous) {
    return { ...summary, phase: 'processing', message: 'Concurrent requests or models · per-request values withheld' };
  }
  const waiting = arrayOfObjects(model.waiting);
  const prefilling = arrayOfObjects(model.prefilling);
  const generatingFlights = arrayOfObjects(model.generating);
  if (prefilling.length + generatingFlights.length + arrayOfObjects(model.activities).length > 1 || (nonnegative(model.active_requests) ?? 0) > 1) {
    return { ...summary, phase: 'processing', message: 'Concurrent requests · per-request speed withheld' };
  }

  for (const prefill of prefilling) {
    const requestID = text(prefill.request_id);
    const waitingRequest = requestID === null
      ? null
      : waiting.find((candidate) => candidate.request_id === requestID) ?? null;
    const matchesLookup = requestID !== null && requestID === text(lookup.request_id);
    const total = tokenCount(prefill.total);
    const done = tokenCount(prefill.processed);
    const promptTokens = firstTokenCount(prefill.prompt_tokens, waitingRequest?.prompt_tokens, matchesLookup ? lookup.prompt_tokens : null);
    const cachedTokens = firstTokenCount(prefill.cached_tokens, matchesLookup ? lookup.reused_kv_tokens : null);
    const progress = done !== null && total !== null && total > 0 && done <= total ? done / total : null;
    summary = {
      ...summary,
      phase: 'prefill',
      message: prefill.progress_stale === true ? 'Prefill is active · waiting for fresh progress' : summary.message,
      livePrefillTPS: prefill.progress_stale === true ? null : firstNumber(prefill.speed),
      promptTokens,
      cachedTokens,
      prefillProgress: progress,
      prefillProcessedTokens: progress !== null ? done : null,
      prefillTotalTokens: progress !== null ? total : null,
      prefillProgressStale: prefill.progress_stale === true,
      prefillEtaMs: prefill.progress_stale !== true && progress !== null && progress < 1 && (nonnegative(prefill.speed) ?? 0) > 0
        ? ms(prefill.eta) : null,
      elapsedMs: secondsToMs(firstNumber(prefill.elapsed)),
    };
  }

  for (const generating of generatingFlights) {
    const generated = tokenCount(generating.generated_tokens) ?? 0;
    const elapsed = nonnegative(generating.elapsed_seconds) ?? 0;
    const age = nonnegative(generating.last_activity_age_seconds);
    const requestID = text(generating.request_id);
    const matchesLookup = requestID !== null && requestID === text(lookup.request_id);
    const promptTokens = firstTokenCount(generating.prompt_tokens, matchesLookup ? lookup.prompt_tokens : null);
    const cachedTokens = tokenCount(matchesLookup ? lookup.reused_kv_tokens : null);
    if (generated <= 0 || elapsed <= 0 || age === null || age > 5) {
      summary = {
        ...summary,
        phase: 'processing',
        message: generated > 0 ? 'No recent output · request still active' : 'Waiting for the first output token',
        promptTokens,
        cachedTokens,
        completionTokens: tokenCount(generating.generated_tokens),
        elapsedMs: ms(generating.elapsed_seconds),
      };
      continue;
    }
    summary = {
      ...summary,
      phase: 'decode',
      message: null,
      liveDecodeTPS: firstNumber(generating.tokens_per_second),
      promptTokens,
      cachedTokens,
      completionTokens: generated,
      elapsedMs: secondsToMs(elapsed),
    };
  }

  const activity = arrayOfObjects(model.activities)[0];
  if (activity && summary.phase === 'idle') {
    // DFlash primary mode reports accepted output through ActivityTrackingMixin.
    // Its elapsed time includes preparation/prefill, so dividing tokens by it
    // would mislabel end-to-end throughput as generation speed.
    const generated = activity.kind === 'generate' ? tokenCount(activity.token_count) : null;
    const elapsed = nonnegative(activity.elapsed_seconds);
    const age = nonnegative(activity.last_activity_age_seconds);
    const fresh = generated !== null && generated > 0 && elapsed !== null && elapsed > 0
      && age !== null && age <= 5 && text(activity.request_id) !== null;
    summary = {
      ...summary,
      phase: fresh ? 'decode' : 'processing',
      completionTokens: generated,
      elapsedMs: secondsToMs(elapsed),
      message: fresh ? 'Output arriving · request-average speed not reported'
        : generated !== null && generated > 0 ? 'Waiting for fresh output'
        : activity.kind === 'generate' ? 'Working · this engine does not report prefill percentage'
        : 'Runtime active · detailed token progress unavailable',
    };
  }
  if ((nonnegative(model.active_requests) ?? 0) > 0 && summary.phase === 'idle') {
    summary = { ...summary, phase: 'processing' };
  }
  if (summary.cachedTokens !== null && (summary.promptTokens === null || summary.cachedTokens > summary.promptTokens)) {
    summary.cachedTokens = null;
  }
  return summary;
};

const normalizeWaiting = (models: JsonObject[], active: JsonObject): number | null => {
  const reported = nonnegative(active.total_waiting_requests)
    ?? (models.length === 0
      ? 0
      : models.every((model) => nonnegative(model.waiting_requests) !== null)
        ? models.reduce((total, model) => total + nonnegative(model.waiting_requests)!, 0)
        : null);
  if (reported === null) return null;
  let overlap = 0;
  for (const model of models) {
    const activeIDs = new Set<string>();
    for (const key of ['prefilling', 'generating', 'activities']) {
      for (const item of arrayOfObjects(model[key])) {
        const id = text(item.request_id);
        if (id !== null) activeIDs.add(id);
      }
    }
    for (const item of arrayOfObjects(model.waiting)) {
      const id = text(item.request_id);
      if (id !== null && activeIDs.has(id)) overlap += 1;
    }
  }
  return Math.max(0, reported - overlap);
};

const normalizeMemory = (active: JsonObject, model: JsonObject | null, cache: JsonObject): OmlxMemory => ({
  // model_memory_used changes meaning when the guard is disabled. Only the
  // enabled guard's current_bytes is unambiguously a process footprint.
  activeBytes: asObject(active.memory_pressure)?.enabled === true
    ? bytes(asObject(active.memory_pressure)?.current_bytes) : null,
  peakBytes: null,
  modelBytes: model?.is_loading === true && model.actual_size === 0 ? null : bytes(model?.actual_size),
  cacheBytes: bytes(cache.hot_cache_size_bytes),
});

const normalizeSessionBank = (cache: JsonObject, lookup: JsonObject): OmlxSessionBank | null => {
  const cold = asObject(cache.cold_tier);
  const bank: OmlxSessionBank = {
    hot: {
      totalBytes: bytes(cache.hot_cache_size_bytes),
      entries: firstNumber(cache.hot_cache_entries),
    },
    cold: cold === null ? null : {
      totalBytes: bytes(cold.physical_bytes),
      entries: firstNumber(cold.entries),
    },
    lastMissReason: cacheLookupReason(lookup.reason),
  };
  return [
    bank.hot?.totalBytes,
    bank.hot?.entries,
    bank.cold?.totalBytes,
    bank.cold?.entries,
    bank.lastMissReason,
  ].some((value) => value !== null && value !== undefined) ? bank : null;
};

export type OmlxSession = Pick<OmlxNormalized, 'sessionAveragePrefillTPS' | 'sessionAverageDecodeTPS' | 'sessionCacheEfficiencyFraction' | 'lifetime'>;
/** The session totals of `/api/status` (or 1.6's `/admin/api/stats`): averages and lifetime counters, as reported. */
export const normalizeSession = (statsData: JsonObject, sessionStatsState: OmlxStatsState = 'fresh', statsAreUsable = true): OmlxSession => ({
  sessionAveragePrefillTPS: firstNumber(statsData.avg_prefill_tps),
  sessionAverageDecodeTPS: firstNumber(statsData.avg_generation_tps),
  sessionCacheEfficiencyFraction: percentToFraction(nonnegative(statsData.cache_efficiency)),
  lifetime: sessionStatsState === 'unavailable' && !statsAreUsable ? null : normalizeLifetime(statsData),
});

const normalizeLifetime = (stats: JsonObject): OmlxLifetime | null => {
  const lifetime = {
    requestsTotal: firstNumber(stats.total_requests),
    promptTokensTotal: firstNumber(stats.total_prompt_tokens),
    completionTokensTotal: firstNumber(stats.total_completion_tokens),
    cachedTokensTotal: firstNumber(stats.total_cached_tokens),
    uptimeMs: ms(stats.uptime_seconds),
  };
  return Object.values(lifetime).some((value) => value !== null) ? lifetime : null;
};

/**
 * Convert the read-only oMLX payloads into small, browser-safe scalars. `session` is the `/api/status` body (session
 * totals; the 1.6 caller passed `/admin/api/stats`), `activity` the `/admin/api/activity` body. Request IDs, prompts
 * and raw payloads never appear in the result. Null when the activity body is not an oMLX activity payload.
 */
export const normalizeOmlx = (
  sessionValue: unknown | null,
  activityValue: unknown | null,
  contextWindows: ReadonlyMap<string, number> = new Map(),
  preferredModel: string | null = null,
  sampledAt = Date.now(),
  sessionStatsState: OmlxStatsState = 'fresh',
): OmlxNormalized | null => {
  const stats = asObject(sessionValue);
  const savedActive = stats === null ? null : asObject(stats.active_models);
  // 1.6 also required stats.engines, the /admin/api/stats marker; /api/status has none (G1).
  const statsAreUsable = stats !== null;
  let active = savedActive;
  if (activityValue !== null) {
    const activity = asObject(activityValue);
    const freshActive = activity === null ? null : asObject(activity.active_models);
    if (freshActive === null) return null;
    active = freshActive;
  }

  if (active === null || !Array.isArray(active.models) || active.models.some((model) => asObject(model) === null)) return null;
  const models = arrayOfObjects(active.models);
  const model = matchingModel(models, preferredModel);
  const modelID = text(model?.id);
  const activeRequests = models.length === 0
    ? 0
    : nonnegative(active.total_active_requests)
      ?? (models.every((item) => nonnegative(item.active_requests) !== null)
        ? models.reduce((total, item) => total + nonnegative(item.active_requests)!, 0)
        : null);
  const activeModelCount = models.filter((item) => (
    (arrayOfObjects(item.prefilling).length + arrayOfObjects(item.generating).length + arrayOfObjects(item.activities).length > 0)
      || (nonnegative(item.active_requests) ?? 0) > 0
  )).length;
  const ambiguous = activeModelCount > 1 || (activeRequests !== null && activeRequests > 1);
  const statsData = statsAreUsable ? stats! : {};
  const cache = asObject(statsData.runtime_cache) ?? {};
  const modelCache = arrayOfObjects(cache.models).find((candidate) => text(candidate.id) === modelID) ?? {};
  const lookup = asObject(modelCache.last_prefix_lookup) ?? {};
  const flight = normalizeFlights(model, lookup, ambiguous);
  const queuedRequests = normalizeWaiting(models, active);
  const pressure = asObject(active.memory_pressure);
  const pressureName = text(pressure?.pressure_level);
  const pressureLevel = pressure?.enabled === true
    ? pressureName === 'critical' || pressureName === 'hard' ? 3 : pressureName === 'soft' ? 2 : pressureName === 'ok' ? 1 : null
    : null;

  const physicalBytes = firstNumber(cache.total_size_bytes);
  const sidecarBytes = arrayOfObjects(cache.models).reduce(
    (total, item) => total + (firstNumber(asObject(item.gdn_staging)?.sidecar_size_bytes) ?? 0),
    0,
  );
  const coldTier = asObject(cache.cold_tier) ?? {
    physical_bytes: physicalBytes === null ? null : physicalBytes + sidecarBytes,
    entries: cache.total_num_files,
  };
  const sessionBank = normalizeSessionBank({ ...cache, cold_tier: coldTier }, lookup);
  const memory = normalizeMemory(active, model, cache);

  return {
    ...normalizeSession(statsData, sessionStatsState, statsAreUsable),
    message: flight.message,
    modelID: modelLabel(modelID),
    loading: model?.is_loading === true,
    phase: models.length === 0 ? 'notLoaded' : flight.phase === 'idle' && queuedRequests !== null && queuedRequests > 0 ? 'queued' : flight.phase,
    sessionStatsState,
    liveDecodeTPS: flight.liveDecodeTPS,
    livePrefillTPS: flight.livePrefillTPS,
    promptTokens: flight.promptTokens,
    cachedTokens: flight.cachedTokens,
    completionTokens: flight.completionTokens,
    prefillProgress: flight.prefillProgress,
    prefillProcessedTokens: flight.prefillProcessedTokens,
    prefillTotalTokens: flight.prefillTotalTokens,
    prefillProgressStale: flight.prefillProgressStale,
    prefillEtaMs: flight.prefillEtaMs,
    elapsedMs: flight.elapsedMs,
    activeRequests,
    queuedRequests,
    contextWindow: modelID === null ? null : contextWindows.get(modelID) ?? null,
    memory,
    sessionBank,
    memoryPressureLevel: pressureLevel,
    sampledAt,
    residentModelCount: models.length,
    residentModels: models.slice(0, MAX_RESIDENT_MODELS).flatMap(item => {
      const id = modelLabel(item.id);
      if (id === null) return [];
      const state = normalizeFlights(item, {});
      const queue = normalizeWaiting([item], {});
      return [{ id, phase: state.phase === 'idle' && (queue ?? 0) > 0 ? 'queued' : state.phase,
        activeRequests: nonnegative(item.active_requests), queuedRequests: queue,
        allocationBytes: item.is_loading === true && item.actual_size === 0 ? null : bytes(item.actual_size), tokensPerSecond: state.liveDecodeTPS ?? state.livePrefillTPS,
        prefillProgress: state.prefillProgress, progressStale: state.prefillProgressStale, loading: item.is_loading === true,
        contextWindow: contextWindows.get(text(item.id) ?? '') ?? null }];
    }),
  };
};
