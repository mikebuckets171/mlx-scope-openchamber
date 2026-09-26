import { parseConnection, parseCatalog, runtimeValue, type Runtime, type ConnectionInfo, type CatalogModel } from './runtime.ts';
import { parseSystemSnapshot, type SystemSnapshot } from './system.ts';

export const TELEMETRY_PHASES = [
  'connecting',
  'reconnecting',
  'offline',
  'notLoaded',
  'idle',
  'queued',
  'prefill',
  'decode',
  'processing',
  'unknown',
] as const;

export type TelemetryPhase = (typeof TELEMETRY_PHASES)[number];

export const TELEMETRY_STATS_STATES = ['fresh', 'stale', 'unavailable'] as const;
export type TelemetryStatsState = (typeof TELEMETRY_STATS_STATES)[number];

export const TELEMETRY_REASONS = [
  'feature_disabled',
  'runtime_unreachable',
  'authentication_failed',
  'unparseable_snapshot',
  'unsupported_contract',
  'host_unavailable',
  'host_timeout',
  'service_not_granted',
  'service_failed',
  'host_disconnected',
  'host_rejected',
] as const;

export type TelemetryReason = (typeof TELEMETRY_REASONS)[number];

export type TelemetryMemory = {
  activeGB: number | null;
  peakGB: number | null;
  modelGB: number | null;
  cacheGB: number | null;
};

export type TelemetryCacheTier = {
  totalGB: number | null;
  entries: number | null;
};

export type TelemetrySessionBank = {
  hot: TelemetryCacheTier | null;
  cold: TelemetryCacheTier | null;
  lastMissReason: string | null;
};

export type TelemetryLifetime = {
  requestsTotal: number | null;
  promptTokensTotal: number | null;
  completionTokensTotal: number | null;
  cachedTokensTotal: number | null;
  uptimeSeconds: number | null;
};

/** Passive Splash status values with their upstream server-wide scopes retained. */
export type TelemetryServerStats = {
  ready: boolean | null;
  aggregateDecodeTokensPerSecond: number | null;
  completedRequests: number | null;
  failedRequests: number | null;
  metalCurrentGB: number | null;
  metalPeakGB: number | null;
};

export type ResidentModel = {
  id: string;
  phase: TelemetryPhase;
  activeRequests: number | null;
  queuedRequests: number | null;
  allocationGB: number | null;
  tokensPerSecond: number | null;
  prefillProgress: number | null;
  progressStale: boolean;
};
export const MAX_RESIDENT_MODELS = 12;

type TelemetryFields = {
  message: string | null;
  runtime: Runtime | null;
  connection?: ConnectionInfo | null;
  catalog?: CatalogModel[];
  modelID: string | null;
  phase: TelemetryPhase;
  sessionStatsState: TelemetryStatsState;
  sessionAveragePrefillTPS: number | null;
  liveDecodeTPS: number | null;
  livePrefillTPS: number | null;
  sessionAverageDecodeTPS: number | null;
  sessionCacheEfficiencyPercent: number | null;
  promptTokens: number | null;
  cachedTokens: number | null;
  completionTokens: number | null;
  prefillProgress: number | null;
  prefillProcessedTokens: number | null;
  prefillTotalTokens: number | null;
  prefillProgressStale: boolean;
  prefillETASeconds: number | null;
  elapsedSeconds: number | null;
  activeRequests: number | null;
  queuedRequests: number | null;
  contextWindow: number | null;
  memory: TelemetryMemory | null;
  sessionBank: TelemetrySessionBank | null;
  lifetime: TelemetryLifetime | null;
  serverStats: TelemetryServerStats | null;
  memoryPressureLevel: number | null;
  memoryPressureSource: string | null;
  sampledAt: number;
  /** Service-local continuity counter. Never a runtime request identifier. */
  traceEpoch: number | null;
  system: SystemSnapshot | null;
  residentModels: ResidentModel[];
  residentModelCount: number | null;
};

export type AvailableTelemetry = TelemetryFields & {
  available: true;
  reason: null;
};

export type UnavailableTelemetry = TelemetryFields & {
  available: false;
  reason: TelemetryReason;
};

export type TelemetrySnapshot = AvailableTelemetry | UnavailableTelemetry;

type JsonObject = { readonly [key: string]: unknown };

const asObject = (value: unknown): JsonObject | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
);

const finite = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const nonnegative = (value: unknown): number | null => {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
};

const tokenCount = (value: unknown): number | null => {
  const number = nonnegative(value);
  return number !== null && Number.isSafeInteger(number) ? number : null;
};
const fraction = (value: unknown): number | null => {
  const number = nonnegative(value);
  return number !== null && number <= 1 ? number : null;
};

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const modelLabel = (value: unknown): string | null => {
  const clean = text(value)?.replace(/[\u0000-\u001f\u007f]/g, '');
  if (!clean) return null;
  const label = /^(?:[\\/]|\.{1,2}[\\/]|~[\\/]|file:|[A-Za-z]:[\\/])/.test(clean)
    ? clean.split(/[\\/]/).filter(Boolean).at(-1) : clean;
  return label?.slice(0, 256) || null;
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

const gb = (value: unknown): number | null => {
  const bytes = nonnegative(value);
  return bytes === null ? null : bytes / 1_000_000_000;
};

const normalizePhase = (value: unknown): TelemetryPhase => {
  const candidate = text(value);
  return candidate !== null && (TELEMETRY_PHASES as readonly string[]).includes(candidate)
    ? candidate as TelemetryPhase
    : 'unknown';
};

const emptyFields = (sampledAt: number): TelemetryFields => ({
  message: null,
  runtime: null,
  connection: null,
  catalog: [],
  modelID: null,
  phase: 'unknown',
  sessionStatsState: 'unavailable',
  sessionAveragePrefillTPS: null,
  liveDecodeTPS: null,
  livePrefillTPS: null,
  sessionAverageDecodeTPS: null,
  sessionCacheEfficiencyPercent: null,
  promptTokens: null,
  cachedTokens: null,
  completionTokens: null,
  prefillProgress: null,
  prefillProcessedTokens: null,
  prefillTotalTokens: null,
  prefillProgressStale: false,
  prefillETASeconds: null,
  elapsedSeconds: null,
  activeRequests: null,
  queuedRequests: null,
  contextWindow: null,
  memory: null,
  sessionBank: null,
  lifetime: null,
  serverStats: null,
  memoryPressureLevel: null,
  memoryPressureSource: null,
  sampledAt,
  traceEpoch: null,
  system: null,
  residentModels: [],
  residentModelCount: null,
});

export const unavailableTelemetry = (
  reason: TelemetryReason,
  message: string | null = null,
  sampledAt = Date.now(),
): UnavailableTelemetry => ({
  available: false,
  reason,
  ...emptyFields(sampledAt),
  message: text(message),
});

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
  phase: TelemetryPhase;
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
  prefillETASeconds: number | null;
  elapsedSeconds: number | null;
  processingElapsed: number | null;
};

const normalizeFlights = (model: JsonObject | null, lookup: JsonObject, ambiguous = false): FlightSummary => {
  if (model === null) {
    return {
      phase: 'idle',
      message: null,
      liveDecodeTPS: null,
      livePrefillTPS: null,
      promptTokens: null,
      cachedTokens: null,
      completionTokens: null,
      prefillProgress: null,
      prefillProcessedTokens: null,
      prefillTotalTokens: null,
      prefillProgressStale: false,
      prefillETASeconds: null,
      elapsedSeconds: null,
      processingElapsed: null,
    };
  }

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
    return {
      phase: 'unknown',
      message: 'Model state unavailable · waiting for a complete runtime sample',
      liveDecodeTPS: null,
      livePrefillTPS: null,
      promptTokens: null,
      cachedTokens: null,
      completionTokens: null,
      prefillProgress: null,
      prefillProcessedTokens: null,
      prefillTotalTokens: null,
      prefillProgressStale: false,
      prefillETASeconds: null,
      elapsedSeconds: null,
      processingElapsed: null,
    };
  }

  let summary: FlightSummary = {
    phase: model.is_loading === true ? 'processing' : 'idle',
    message: model.is_loading === true ? 'Loading the model · no token speed yet' : null,
    liveDecodeTPS: null,
    livePrefillTPS: null,
    promptTokens: null,
    cachedTokens: null,
    completionTokens: null,
    prefillProgress: null,
    prefillProcessedTokens: null,
    prefillTotalTokens: null,
    prefillProgressStale: false,
    prefillETASeconds: null,
    elapsedSeconds: null,
    processingElapsed: nonnegative(model.loading_elapsed_seconds),
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
      prefillETASeconds: prefill.progress_stale !== true && progress !== null && progress < 1 && (nonnegative(prefill.speed) ?? 0) > 0
        ? nonnegative(prefill.eta) : null,
      elapsedSeconds: firstNumber(prefill.elapsed),
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
        processingElapsed: nonnegative(generating.elapsed_seconds),
        promptTokens,
        cachedTokens,
        completionTokens: tokenCount(generating.generated_tokens),
        elapsedSeconds: nonnegative(generating.elapsed_seconds),
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
      elapsedSeconds: elapsed,
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
      elapsedSeconds: elapsed,
      processingElapsed: elapsed,
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

const normalizeMemory = (active: JsonObject, model: JsonObject | null, cache: JsonObject): TelemetryMemory => ({
  // model_memory_used changes meaning when the guard is disabled. Only the
  // enabled guard's current_bytes is unambiguously a process footprint.
  activeGB: asObject(active.memory_pressure)?.enabled === true
    ? gb(asObject(active.memory_pressure)?.current_bytes) : null,
  peakGB: null,
  modelGB: model?.is_loading === true && model.actual_size === 0 ? null : gb(model?.actual_size),
  cacheGB: gb(cache.hot_cache_size_bytes),
});

const normalizeSessionBank = (cache: JsonObject, lookup: JsonObject): TelemetrySessionBank | null => {
  const cold = asObject(cache.cold_tier);
  const bank: TelemetrySessionBank = {
    hot: {
      totalGB: gb(cache.hot_cache_size_bytes),
      entries: firstNumber(cache.hot_cache_entries),
    },
    cold: cold === null ? null : {
      totalGB: gb(cold.physical_bytes),
      entries: firstNumber(cold.entries),
    },
    lastMissReason: cacheLookupReason(lookup.reason),
  };
  return [
    bank.hot?.totalGB,
    bank.hot?.entries,
    bank.cold?.totalGB,
    bank.cold?.entries,
    bank.lastMissReason,
  ].some((value) => value !== null && value !== undefined) ? bank : null;
};

const normalizeLifetime = (stats: JsonObject): TelemetryLifetime | null => {
  const lifetime = {
    requestsTotal: firstNumber(stats.total_requests),
    promptTokensTotal: firstNumber(stats.total_prompt_tokens),
    completionTokensTotal: firstNumber(stats.total_completion_tokens),
    cachedTokensTotal: firstNumber(stats.total_cached_tokens),
    uptimeSeconds: firstNumber(stats.uptime_seconds),
  };
  return Object.values(lifetime).some((value) => value !== null) ? lifetime : null;
};

/**
 * Convert the read-only oMLX dashboard payloads into the extension's small,
 * browser-safe scalar contract. Request IDs, prompts, and raw payloads never
 * appear in the returned object.
 */
export const normalizeOmlxTelemetry = (
  statsValue: unknown | null,
  activityValue: unknown | null,
  contextWindows: ReadonlyMap<string, number> = new Map(),
  preferredModel: string | null = null,
  sampledAt = Date.now(),
  sessionStatsState: TelemetryStatsState = 'fresh',
): AvailableTelemetry | null => {
  const stats = asObject(statsValue);
  const savedActive = stats === null ? null : asObject(stats.active_models);
  const statsAreUsable = stats !== null && savedActive !== null && asObject(stats.engines) !== null;
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
    available: true,
    reason: null,
    message: flight.message,
    runtime: 'omlx',
    connection: null,
    catalog: [],
    modelID: modelLabel(modelID),
    phase: models.length === 0 ? 'notLoaded' : flight.phase === 'idle' && queuedRequests !== null && queuedRequests > 0 ? 'queued' : flight.phase,
    sessionStatsState,
    sessionAveragePrefillTPS: firstNumber(statsData.avg_prefill_tps),
    liveDecodeTPS: flight.liveDecodeTPS,
    livePrefillTPS: flight.livePrefillTPS,
    sessionAverageDecodeTPS: firstNumber(statsData.avg_generation_tps),
    sessionCacheEfficiencyPercent: (nonnegative(statsData.cache_efficiency) ?? Infinity) <= 100 ? nonnegative(statsData.cache_efficiency) : null,
    promptTokens: flight.promptTokens,
    cachedTokens: flight.cachedTokens,
    completionTokens: flight.completionTokens,
    prefillProgress: flight.prefillProgress,
    prefillProcessedTokens: flight.prefillProcessedTokens,
    prefillTotalTokens: flight.prefillTotalTokens,
    prefillProgressStale: flight.prefillProgressStale,
    prefillETASeconds: flight.prefillETASeconds,
    elapsedSeconds: flight.elapsedSeconds,
    activeRequests,
    queuedRequests,
    contextWindow: modelID === null ? null : contextWindows.get(modelID) ?? null,
    memory,
    sessionBank,
    lifetime: sessionStatsState === 'unavailable' && !statsAreUsable ? null : normalizeLifetime(statsData),
    serverStats: null,
    memoryPressureLevel: pressureLevel,
    memoryPressureSource: pressureLevel === null ? null : 'oMLX process memory guard (not macOS pressure)',
    sampledAt,
    traceEpoch: null,
    system: null,
    residentModelCount: models.length,
    residentModels: models.slice(0, MAX_RESIDENT_MODELS).flatMap(item => {
      const id = modelLabel(item.id);
      if (id === null) return [];
      const state = normalizeFlights(item, {});
      const queue = normalizeWaiting([item], {});
      return [{ id, phase: state.phase === 'idle' && (queue ?? 0) > 0 ? 'queued' : state.phase,
        activeRequests: nonnegative(item.active_requests), queuedRequests: queue,
        allocationGB: item.is_loading === true && item.actual_size === 0 ? null : gb(item.actual_size), tokensPerSecond: state.liveDecodeTPS ?? state.livePrefillTPS,
        prefillProgress: state.prefillProgress, progressStale: state.prefillProgressStale }];
    }),
  };
};

const normalizeMemoryFromPanel = (value: unknown): TelemetryMemory | null => {
  const memory = asObject(value);
  if (memory === null) return null;
  return {
    activeGB: nonnegative(memory.activeGB),
    peakGB: nonnegative(memory.peakGB),
    modelGB: nonnegative(memory.modelGB),
    cacheGB: nonnegative(memory.cacheGB),
  };
};

const normalizeSessionBankFromPanel = (value: unknown): TelemetrySessionBank | null => {
  const bank = asObject(value);
  if (bank === null) return null;
  const tier = (entry: unknown): TelemetryCacheTier | null => {
    const object = asObject(entry);
    return object === null ? null : { totalGB: nonnegative(object.totalGB), entries: nonnegative(object.entries) };
  };
  const normalized: TelemetrySessionBank = {
    hot: tier(bank.hot),
    cold: tier(bank.cold),
    lastMissReason: cacheLookupReason(bank.lastMissReason),
  };
  return [
    normalized.hot?.totalGB,
    normalized.hot?.entries,
    normalized.cold?.totalGB,
    normalized.cold?.entries,
    normalized.lastMissReason,
  ].some((entry) => entry !== null && entry !== undefined) ? normalized : null;
};

const normalizeLifetimeFromPanel = (value: unknown): TelemetryLifetime | null => {
  const lifetime = asObject(value);
  if (lifetime === null) return null;
  return {
    requestsTotal: nonnegative(lifetime.requestsTotal),
    promptTokensTotal: nonnegative(lifetime.promptTokensTotal),
    completionTokensTotal: nonnegative(lifetime.completionTokensTotal),
    cachedTokensTotal: nonnegative(lifetime.cachedTokensTotal),
    uptimeSeconds: nonnegative(lifetime.uptimeSeconds),
  };
};

const normalizeServerStatsFromPanel = (value: unknown): TelemetryServerStats | null => {
  const item = asObject(value);
  if (!item) return null;
  return {
    ready: typeof item.ready === 'boolean' ? item.ready : null,
    aggregateDecodeTokensPerSecond: nonnegative(item.aggregateDecodeTokensPerSecond),
    completedRequests: tokenCount(item.completedRequests),
    failedRequests: tokenCount(item.failedRequests),
    metalCurrentGB: nonnegative(item.metalCurrentGB),
    metalPeakGB: nonnegative(item.metalPeakGB),
  };
};

const parseResidentModels = (value: unknown): ResidentModel[] => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_RESIDENT_MODELS).flatMap(entry => {
    const item = asObject(entry), id = modelLabel(item?.id);
    if (!item || !id) return [];
    const phase = normalizePhase(item.phase), progressStale = item.progressStale === true;
    const active = tokenCount(item.activeRequests);
    return [{ id, phase, activeRequests: active,
      queuedRequests: tokenCount(item.queuedRequests), allocationGB: nonnegative(item.allocationGB),
      tokensPerSecond: (active ?? 0) <= 1 && (phase === 'decode' || phase === 'prefill' && !progressStale) ? nonnegative(item.tokensPerSecond) : null,
      prefillProgress: phase === 'prefill' && (active ?? 0) <= 1 ? fraction(item.prefillProgress) : null, progressStale }];
  });
};

/** Validate the service response before any value enters the DOM. */
export const parseTelemetrySnapshot = (value: unknown, observedAt?: number): TelemetrySnapshot => {
  const record = asObject(value);
  const sampledAt = finite(observedAt) ?? finite(record?.sampledAt) ?? Date.now();
  if (record?.available !== true) {
    const reason = text(record?.reason);
    const safeReason = reason !== null && (TELEMETRY_REASONS as readonly string[]).includes(reason)
      ? reason as TelemetryReason
      : 'unparseable_snapshot';
    return { ...unavailableTelemetry(safeReason, text(record?.message), sampledAt), system: parseSystemSnapshot(record?.system), connection: parseConnection(record?.connection), catalog: parseCatalog(record?.catalog) };
  }
  const statsState = text(record.sessionStatsState);
  const sessionStatsState = statsState !== null && (TELEMETRY_STATS_STATES as readonly string[]).includes(statsState)
    ? statsState as TelemetryStatsState
    : 'unavailable';
  const phase = normalizePhase(record.phase);
  const active = nonnegative(record.activeRequests);
  const queued = nonnegative(record.queuedRequests);
  const done = tokenCount(record.prefillProcessedTokens);
  const total = tokenCount(record.prefillTotalTokens);
  const hasCounts = record.prefillProcessedTokens != null || record.prefillTotalTokens != null;
  const progress = hasCounts
    ? done !== null && total !== null && total > 0 && done <= total ? done / total : null
    : fraction(record.prefillProgress);
  return {
    available: true,
    reason: null,
    message: text(record.message),
    runtime: runtimeValue(record.runtime),
    connection: parseConnection(record.connection),
    catalog: parseCatalog(record.catalog),
    modelID: modelLabel(record.modelID),
    phase,
    sessionStatsState,
    sessionAveragePrefillTPS: nonnegative(record.sessionAveragePrefillTPS),
    liveDecodeTPS: nonnegative(record.liveDecodeTPS),
    livePrefillTPS: nonnegative(record.livePrefillTPS),
    sessionAverageDecodeTPS: nonnegative(record.sessionAverageDecodeTPS),
    sessionCacheEfficiencyPercent: nonnegative(record.sessionCacheEfficiencyPercent),
    promptTokens: tokenCount(record.promptTokens),
    cachedTokens: tokenCount(record.cachedTokens),
    completionTokens: tokenCount(record.completionTokens),
    prefillProgress: phase === 'prefill' ? progress : null,
    prefillProcessedTokens: progress !== null && phase === 'prefill' ? done : null,
    prefillTotalTokens: progress !== null && phase === 'prefill' ? total : null,
    prefillProgressStale: record.prefillProgressStale === true,
    prefillETASeconds: phase === 'prefill' && progress !== null && progress < 1 && record.prefillProgressStale !== true
      && (nonnegative(record.livePrefillTPS) ?? 0) > 0 ? nonnegative(record.prefillETASeconds) : null,
    elapsedSeconds: nonnegative(record.elapsedSeconds),
    activeRequests: active,
    queuedRequests: queued,
    contextWindow: nonnegative(record.contextWindow),
    memory: normalizeMemoryFromPanel(record.memory),
    sessionBank: normalizeSessionBankFromPanel(record.sessionBank),
    lifetime: normalizeLifetimeFromPanel(record.lifetime),
    serverStats: normalizeServerStatsFromPanel(record.serverStats),
    memoryPressureLevel: nonnegative(record.memoryPressureLevel) === null
      ? null
      : Math.min(3, Math.trunc(nonnegative(record.memoryPressureLevel)!)),
    memoryPressureSource: text(record.memoryPressureSource),
    sampledAt,
    traceEpoch: nonnegative(record.traceEpoch),
    system: parseSystemSnapshot(record.system),
    residentModels: parseResidentModels(record.residentModels),
    residentModelCount: tokenCount(record.residentModelCount),
  };
};

export const __test__ = {
  asObject,
  finite,
  nonnegative,
  normalizeFlights,
  normalizeWaiting,
  normalizePhase,
};
