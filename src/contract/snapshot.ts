import { parseChatMeasurement, type ChatMeasurement } from './chat.ts';
import { parseAlertLog, parseAlerts, type AlertLogEntryV2, type AlertV2 } from './alerts.ts';
import { parseCapabilities, type Capabilities, type CapabilityKey } from './capabilities.ts';
import { parseCompletionsV2, type CompletionsV2 } from './completion.ts';
import {
  at, bool, classAKeys, connectionId, count, defined, fraction, hex8, label, list, modelLabel, nonneg, obj, oneOf, opt, optionalFields, type Json,
} from './guards.ts';
import { parseHostV2, type HostV2 } from './host.ts';
import { parseParams, STATUS_PARAMS, statusReason, statusState, type ReasonParams, type StatusReason, type StatusState } from './reasons.ts';
import { runtimeKind, type RuntimeKind } from './runtime.ts';
import { CONTRACT_VERSION } from './version.ts';

export type { RuntimeKind } from './runtime.ts';
export const SURFACES = ['panel', 'page', 'status'] as const;
export type Surface = typeof SURFACES[number];
export const PHASES = ['idle', 'queued', 'prefill', 'decode', 'processing', 'loading', 'not-loaded', 'unknown'] as const;
export type Phase = typeof PHASES[number];
export const LIMITS = { choices: 8, residency: 12, slots: 16, catalog: 12, engines: 8 } as const;

export interface SnapshotV2 {
  contractVersion: 2;
  serverNow: number;
  service: { version: string; instance: string };   // instance: 8 hex, random per service start
  connection: ConnectionV2;
  status: StatusV2;
  capabilities: Capabilities;
  runtime: RuntimeV2;
  host: HostV2 | null;                       // 2a amendment: null when the host sampler has no reading
  completions: CompletionsV2;
  marksHead: number;                         // newest turn-mark seq in the 64-entry ring; 0 when empty
  alerts: AlertV2[];
  alertLog: AlertLogEntryV2[];               // ≤ 20, newest first, service memory only
  lease: LeaseV2;
  nextPollMs: number;
  chat?: ChatMeasurement | null;              // 3.0 optional selected-chat delivery observation
  mediaEnabled?: boolean;                    // Cached setting only; snapshot reads never collect media.
  /** 5.1: the selected chat's newest two prompts as the runtime reported them (total and reused tokens). Never exported. */
  promptCache?: PromptCacheV2;
}
export interface PromptCountsV2 { total: number; cache: number; observedAt: number }
export interface PromptCacheV2 { basis: 'reported'; latest: PromptCountsV2; previous: PromptCountsV2 | null }
const promptCounts = (value: unknown, serverNow: number): PromptCountsV2 | null => {
  const item = obj(value), total = count(item?.total), cache = count(item?.cache), observedAt = at(item?.observedAt);
  return total && cache !== null && cache <= total && observedAt !== null && observedAt <= serverNow ? { total, cache, observedAt } : null;
};
/** Both prompts must be well formed and in order; anything else is withheld rather than partly shown. */
export const parsePromptCache = (value: unknown, serverNow: number): PromptCacheV2 | undefined => {
  const item = obj(value), latest = promptCounts(item?.latest, serverNow);
  if (!item || item.basis !== 'reported' || !latest) return undefined;
  if (item.previous === null || item.previous === undefined) return { basis: 'reported', latest, previous: null };
  const previous = promptCounts(item.previous, serverNow);
  return previous && previous.observedAt <= latest.observedAt ? { basis: 'reported', latest, previous } : undefined;
};
export interface StatusV2 { state: StatusState; reason: StatusReason | null; params: ReasonParams; sinceAt?: number }

export const DETECTION_BASES = ['explicit', 'hint', 'probe'] as const;
export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export const PROBES = ['/health', '/props', '/api/version', '/lmstudio-greeting', '/status', '/v1/models'] as const;
export interface ConnectionV2 {
  id: string;                                // [A-Za-z0-9._-]{1,64}; 'auto' when nothing is selected
  label: string;
  runtime: RuntimeKind | null;
  version?: string;                          // runtime version when reported, e.g. '0.7.0rc1'
  engine?: 'splash' | null;                  // an LM Studio-compatible host serving Splash models
  host?: 'bionic' | 'llama-swap' | null;   // 'llama-swap': read through llama-swap's ready model server
  generation: number;                        // +1 on connection change, re-detection, or an LM Studio model state change
  choices: Array<{ id: string; label: string; runtime: RuntimeKind | null }>;   // ≤ 8
  detection: { basis: typeof DETECTION_BASES[number]; confidence: typeof CONFIDENCES[number]; probe?: typeof PROBES[number] };
  /** 5.3: the names the provider's OpenCode `models` entries give their IDs (≤ 32). Display only; IDs stay the identity. */
  modelNames?: Array<{ model: string; name: string }>;
}
export const MODEL_NAMES_MAX = 32;

export interface RuntimeV2 {
  sampledAt?: number;                        // 2a amendment: when the runtime reading was taken; absent = serverNow
  phase: Phase;
  request: RequestV2 | null;                 // null unless exactly one request is active and the runtime reports it
  server: {
    active: number | null;                   // null = cannot count requests
    queued: number | null;
    averages?: { decodeTps?: number; prefillTps?: number; cacheEfficiencyFraction?: number;
                 requestsTotal?: number; failedTotal?: number; uptimeMs?: number };
    histograms?: { ttftMs?: Quantiles; itlMs?: Quantiles };
    cache?: { ramBytes?: number; ssdBytes?: number; ramEntries?: number; ssdEntries?: number; lastLookup?: 'hit' | 'miss' };
    speculative?: { draftedTokens: number; acceptedTokens: number; acceptanceFraction: number; windowMs: number };
    rates?: { promptTps?: number; decodeTps?: number; windowMs: number;
              promptWindowMs?: number };    // independent prompt interval; windowMs is decode's when both are present
  };
  memory: { processBytes?: number; modelBytes?: number; metalBytes?: number; metalPeakBytes?: number; ceilingBytes?: number;
            guard?: MemoryGuard };           // §12.4: the oMLX process memory guard, not macOS pressure
  residency: ResidencyV2[];                  // ≤ 12
  residencyCount?: number;                   // 2a amendment: models the runtime reports, when it can count them (can exceed 12)
  slots: SlotV2[];                           // ≤ 16, llama-server numeric allowlist
  catalog: CatalogV2[];                      // ≤ 12
  engines: EngineV2[];                       // ≤ 8
}
/** oMLX's memory guard tier (`memory_pressure.pressure_level`): `hard` pauses admission. Present only while the guard runs. */
export const MEMORY_GUARDS = ['ok', 'soft', 'hard'] as const;
export type MemoryGuard = typeof MEMORY_GUARDS[number];
export interface RequestV2 {
  model: string | null;
  decodeTps?: number; prefillTps?: number;
  prefillProcessedTokens?: number; prefillTotalTokens?: number; prefillFraction?: number; prefillStale?: boolean;
  /** Native progress observation time, separate from the current /status sample time. Never a request identity. */
  prefillObservedAt?: number;
  prefillEtaMs?: number;                     // runtime estimate; only while prefill is live and fraction < 1
  promptTokens?: number; cachedTokens?: number; outputTokens?: number;
  elapsedMs?: number; ttftMs?: number;
  contextWindowTokens?: number; contextUsedTokens?: number;
}
export interface Quantiles { p50: number; p95: number; n: number; window: 'native-last-4096' }
export interface ResidencyV2 {
  model: string;
  phase: Phase;
  source: 'runtime' | 'lms-ps' | 'ollama-ps';
  active?: number; queued?: number;
  bytes?: number;                            // runtime-reported allocation or Ollama size
  gpuResidentBytes?: number;                 // Ollama size_vram: "GPU-resident (Ollama-reported)"
  unloadsAt?: number;                        // Ollama expires_at
  contextWindowTokens?: number;
  decodeTps?: number; prefillFraction?: number;
  prefillTps?: number; prefillStale?: boolean;   // 2a amendment: 1.6 shows a prefilling model's speed and stale progress
}
export interface SlotV2 {
  id: number; busy: boolean; contextWindowTokens: number;
  decodedTokens?: number; remainingTokens?: number; promptTokens?: number;
  decodeTps?: number;                        // observed, and only while exactly one slot is busy
}
export interface CatalogV2 {
  name: string; format: 'mlx' | 'gguf' | 'splash' | null; loaded: boolean | null; contextWindowTokens: number | null;
  vision?: boolean; inputModalities?: Array<'text' | 'image' | 'audio' | 'pdf'>;
}
export interface EngineV2 { name: string; version: string; selected: boolean; format?: string }   // format: lms runtime ls model format, e.g. 'yuzu' (§12.3)
export interface LeaseV2 { leader: boolean; epoch: number; ttlMs: number; leaderSurface: 'page' | 'panel' | 'status' | null }

/** Field → capability (P3). A present value without its capability is removed by `parseSnapshotV2`. */
// Expand shared path prefixes once, retaining the public field/capability allowlist.
const capabilityFields = (path: string, capability: string, groups: Record<string, string>): Array<readonly [string, CapabilityKey]> =>
  Object.entries(groups).flatMap(([key, fields]) => fields.split(' ').map(field => [path + field, capability + key] as [string, CapabilityKey]));
export const HONESTY: ReadonlyArray<readonly [string, CapabilityKey]> = [
  ...capabilityFields('runtime.request.', 'request.', {
    decodeRate: 'decodeTps', prefillRate: 'prefillTps',
    prefillProgress: 'prefillFraction prefillProcessedTokens prefillTotalTokens prefillStale prefillObservedAt',
    prefillEta: 'prefillEtaMs', ttft: 'ttftMs', tokens: 'promptTokens cachedTokens outputTokens', elapsed: 'elapsedMs',
    context: 'contextWindowTokens contextUsedTokens',
  }),
  ...capabilityFields('runtime.server.', 'server.', {
    requests: 'active queued', averages: 'averages', latency: 'histograms', cache: 'cache', speculative: 'speculative', rates: 'rates',
  }),
  ...capabilityFields('runtime.memory.', 'server.memory.', {
    process: 'processBytes guard', model: 'modelBytes', metal: 'metalBytes metalPeakBytes', ceiling: 'ceilingBytes',
  }),
  ...capabilityFields('runtime.', 'server.', { residency: 'residency residencyCount', slots: 'slots', catalog: 'catalog', engines: 'engines' }),
  ['completions.items', 'server.completions'],
  ...capabilityFields('host.', 'host.', {
    cpu: 'cpuFraction', memory: 'memUsedBytes memTotalBytes mac.wiredBytes mac.compressedBytes',
    swap: 'mac.swapUsedBytes mac.swapTotalBytes', pressure: 'mac.pressureLevel', wiredLimit: 'mac.wiredLimitBytes',
    gpuBusy: 'gpu.busyFraction', gpuMemory: 'gpu.allocBytes gpu.inUseBytes', thermal: 'thermal', footprint: 'runtimeProcess', power: 'power',
  }),
];
const valueAt = (root: unknown, path: string): unknown => path.split('.').reduce<unknown>((value, key) => obj(value)?.[key], root);
const present = (value: unknown): boolean => value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);
/** The capabilities a body's present fields need. */
export const requiredCapabilities = (snapshot: object): CapabilityKey[] =>
  [...new Set(HONESTY.filter(([path]) => present(valueAt(snapshot, path))).map(([, key]) => key))];
/** Every present field whose capability is absent, as `path → key`. The service asserts this is empty. */
export const honestyViolations = (snapshot: object): string[] => {
  const capabilities = obj((snapshot as Json).capabilities) ?? {};
  return HONESTY.filter(([path, key]) => present(valueAt(snapshot, path)) && !capabilities[key]).map(([path, key]) => `${path} → ${key}`);
};
const withhold = (snapshot: SnapshotV2): void => {
  for (const [path, key] of HONESTY) {
    if (snapshot.capabilities[key] || !present(valueAt(snapshot, path))) continue;
    const keys = path.split('.'), leaf = keys.pop()!, parent = valueAt(snapshot, keys.join('.')) as Json;
    if (Array.isArray(parent[leaf])) parent[leaf] = [];
    else if (leaf === 'active' || leaf === 'queued') parent[leaf] = null;   // required: null means "cannot count"
    else delete parent[leaf];
  }
};

const phase = (value: unknown): Phase => oneOf(PHASES)(value) ?? 'unknown';
const int = (value: unknown): number | undefined => opt(count(value));
const num = (value: unknown): number | undefined => opt(nonneg(value));
const nonEmpty = <T extends object>(value: T): T | undefined => Object.keys(value).length ? value : undefined;
const limit = (value: unknown): number | null => { const n = count(value); return n ? n : null; };

const requestFields = optionalFields({ decodeTps: nonneg, promptTokens: count, cachedTokens: count, outputTokens: count,
  elapsedMs: nonneg, ttftMs: nonneg, contextWindowTokens: limit, contextUsedTokens: count });
const residencyFields = optionalFields({ queued: count, bytes: count, gpuResidentBytes: count, unloadsAt: at, contextWindowTokens: limit });
const slotFields = optionalFields({ decodedTokens: count, remainingTokens: count, promptTokens: count, decodeTps: nonneg });
const averageFields = optionalFields({ decodeTps: nonneg, prefillTps: nonneg, cacheEfficiencyFraction: fraction,
  requestsTotal: count, failedTotal: count, uptimeMs: nonneg });
const cacheFields = optionalFields({ ramBytes: count, ssdBytes: count, ramEntries: count, ssdEntries: count,
  lastLookup: oneOf(['hit', 'miss'] as const) });

/** Cross-field rules ported from the 1.6 panel parser (src/telemetry.ts parseTelemetrySnapshot). */
const request = (value: unknown, current: Phase): RequestV2 | null => {
  const item = obj(value);
  if (!item) return null;
  const done = count(item.prefillProcessedTokens), total = count(item.prefillTotalTokens);
  // Counts, when sent, decide progress; a fraction without valid counts is not trusted.
  const hasCounts = item.prefillProcessedTokens != null || item.prefillTotalTokens != null;
  const progress = hasCounts ? done !== null && total !== null && total > 0 && done <= total ? done / total : null : fraction(item.prefillFraction);
  const prefill = current === 'prefill' ? progress : null, stale = item.prefillStale === true, prefillTps = nonneg(item.prefillTps);
  return defined({
    ...requestFields(item), model: modelLabel(item.model), prefillTps: opt(prefillTps),
    prefillProcessedTokens: prefill !== null ? opt(done) : undefined, prefillTotalTokens: prefill !== null ? opt(total) : undefined,
    prefillFraction: opt(prefill), prefillStale: stale || undefined,
    prefillObservedAt: prefill !== null && count(item.prefillObservedAt) !== null ? opt(at(item.prefillObservedAt)) : undefined,
    prefillEtaMs: prefill !== null && prefill < 1 && !stale && (prefillTps ?? 0) > 0 ? num(item.prefillEtaMs) : undefined,
  });
};
const residency = (value: unknown): ResidencyV2 | null => {
  const item = obj(value), model = modelLabel(item?.model), source = oneOf(['runtime', 'lms-ps', 'ollama-ps'] as const)(item?.source);
  if (!item || !model || !source) return null;
  const current = phase(item.phase), active = count(item.active), stale = item.prefillStale === true;
  // Per-model speed and progress only while that model has at most one request.
  const single = (active ?? 0) <= 1;
  return defined({
    ...residencyFields(item), model, phase: current, source, active: opt(active),
    decodeTps: single && current === 'decode' ? num(item.decodeTps) : undefined,
    prefillFraction: single && current === 'prefill' ? opt(fraction(item.prefillFraction)) : undefined,
    prefillTps: single && current === 'prefill' && !stale ? num(item.prefillTps) : undefined, prefillStale: stale || undefined,
  });
};
const slots = (value: unknown): SlotV2[] => {
  const parsed = list(value, LIMITS.slots, raw => {
    const item = obj(raw), id = count(item?.id), busy = bool(item?.busy), context = count(item?.contextWindowTokens);
    return item && id !== null && busy !== null && context !== null ? defined({ ...slotFields(item), id, busy, contextWindowTokens: context }) : null;
  });
  // An observed per-slot rate is only honest while exactly one slot is busy.
  const single = parsed.filter(slot => slot.busy).length === 1;
  return parsed.map(slot => single && slot.busy ? slot : (({ decodeTps: _, ...rest }) => rest)(slot));
};
const ENGINE_FORMAT = /^[a-z0-9._-]{1,16}$/;   // §12.3: a lower-case format token (gguf, mlx, yuzu), never free text
const MODALITIES = ['text', 'image', 'audio', 'pdf'] as const;   // Splash 1.1 reports 'pdf' (fixture report)
const catalog = (value: unknown): CatalogV2 | null => {
  const item = obj(value), name = label(item?.name, 160), context = limit(item?.contextWindowTokens);
  if (!item || !name) return null;
  const modalities = Array.isArray(item.inputModalities) ? [...new Set(item.inputModalities.filter(oneOf(MODALITIES)))] as CatalogV2['inputModalities'] : undefined;
  return defined({ name, format: oneOf(['mlx', 'gguf', 'splash'] as const)(item.format), loaded: bool(item.loaded),
    contextWindowTokens: context, vision: opt(bool(item.vision)), inputModalities: modalities });
};
const quantiles = (value: unknown): Quantiles | undefined => {
  const item = obj(value), p50 = nonneg(item?.p50), p95 = nonneg(item?.p95), n = count(item?.n);
  return p50 !== null && p95 !== null && p50 <= p95 && n !== null && item?.window === 'native-last-4096' ? { p50, p95, n, window: 'native-last-4096' } : undefined;
};
const server = (value: unknown): RuntimeV2['server'] => {
  const item = obj(value) ?? {}, averages = obj(item.averages), histograms = obj(item.histograms), cache = obj(item.cache);
  const speculative = obj(item.speculative), rates = obj(item.rates);
  const drafted = count(speculative?.draftedTokens), accepted = count(speculative?.acceptedTokens);
  const acceptance = fraction(speculative?.acceptanceFraction), specWindow = nonneg(speculative?.windowMs), rateWindow = nonneg(rates?.windowMs);
  return defined({
    active: count(item.active), queued: count(item.queued),
    averages: averages ? nonEmpty(averageFields(averages)) : undefined,
    histograms: histograms ? nonEmpty(defined({ ttftMs: quantiles(histograms.ttftMs), itlMs: quantiles(histograms.itlMs) })) : undefined,
    cache: cache ? nonEmpty(cacheFields(cache)) : undefined,
    speculative: drafted !== null && accepted !== null && accepted <= drafted && acceptance !== null && specWindow !== null
      ? { draftedTokens: drafted, acceptedTokens: accepted, acceptanceFraction: acceptance, windowMs: specWindow } : undefined,
    rates: rateWindow !== null ? defined({ promptTps: num(rates!.promptTps), decodeTps: num(rates!.decodeTps), windowMs: rateWindow,
      promptWindowMs: num(rates!.promptWindowMs) }) : undefined,
  });
};
const memory = (value: unknown): RuntimeV2['memory'] => {
  const item = obj(value) ?? {}, metal = count(item.metalBytes), peak = count(item.metalPeakBytes);
  return defined({ processBytes: int(item.processBytes), modelBytes: int(item.modelBytes), metalBytes: opt(metal),
    // A peak below the current allocation is not a peak.
    metalPeakBytes: peak !== null && (metal === null || peak >= metal) ? peak : undefined, ceilingBytes: int(item.ceilingBytes),
    guard: opt(oneOf(MEMORY_GUARDS)(item.guard)) });
};
const runtime = (value: unknown): RuntimeV2 | null => {
  const item = obj(value);
  if (!item) return null;
  const current = phase(item.phase);
  return defined({
    sampledAt: opt(at(item.sampledAt)), phase: current, request: request(item.request, current), server: server(item.server), memory: memory(item.memory),
    residency: list(item.residency, LIMITS.residency, residency), residencyCount: int(item.residencyCount), slots: slots(item.slots),
    catalog: list(item.catalog, LIMITS.catalog, catalog),
    engines: list(item.engines, LIMITS.engines, raw => {
      const engine = obj(raw), name = label(engine?.name, 40), version = label(engine?.version, 40), selected = bool(engine?.selected);
      const format = typeof engine?.format === 'string' && ENGINE_FORMAT.test(engine.format) ? engine.format : undefined;
      return name && version && selected !== null ? defined({ name, version, selected, format }) : null;
    }),
  });
};
const choice = (value: unknown): ConnectionV2['choices'][number] | null => {
  const item = obj(value), id = connectionId(item?.id), name = label(item?.label);
  return id && name ? { id, label: name, runtime: runtimeKind(item?.runtime) } : null;
};
const connection = (value: unknown): ConnectionV2 | null => {
  const item = obj(value), id = connectionId(item?.id), name = label(item?.label), generation = count(item?.generation), detection = obj(item?.detection);
  const detectionBasis = oneOf(DETECTION_BASES)(detection?.basis), confidence = oneOf(CONFIDENCES)(detection?.confidence);
  if (!item || !id || !name || generation === null || !detectionBasis || !confidence) return null;
  const modelNames = list(item.modelNames, MODEL_NAMES_MAX, modelName);
  return defined({
    id, label: name, runtime: runtimeKind(item.runtime),
    version: typeof item.version === 'string' && /^[A-Za-z0-9._+-]{1,40}$/.test(item.version) ? item.version : undefined,
    engine: item.engine === 'splash' ? 'splash' as const : undefined, host: item.host === 'bionic' || item.host === 'llama-swap' ? item.host as 'bionic' | 'llama-swap' : undefined,
    generation, choices: list(item.choices, LIMITS.choices, choice),
    detection: defined({ basis: detectionBasis, confidence, probe: opt(oneOf(PROBES)(detection?.probe)) }),
    modelNames: modelNames.length ? modelNames : undefined,
  });
};
const modelName = (value: unknown): { model: string; name: string } | null => {
  const item = obj(value), model = modelLabel(item?.model), name = modelLabel(item?.name, 80);
  return model && name ? { model, name } : null;
};
const status = (value: unknown): StatusV2 | null => {
  const item = obj(value), state = statusState(item?.state), reason = statusReason(item?.reason);
  if (!item || !state || item.reason != null && !reason) return null;
  return defined({ state, reason, params: reason ? parseParams(item.params, STATUS_PARAMS[reason]) : {}, sinceAt: opt(at(item.sinceAt)) });
};
const lease = (value: unknown): LeaseV2 | null => {
  const item = obj(value), leader = bool(item?.leader), epoch = count(item?.epoch), ttl = nonneg(item?.ttlMs);
  const surface = item?.leaderSurface === null ? null : oneOf(['page', 'panel', 'status'] as const)(item?.leaderSurface);
  return leader !== null && epoch !== null && ttl !== null && (surface !== null || item?.leaderSurface === null)
    ? { leader, epoch, ttlMs: ttl, leaderSurface: surface } : null;
};

/**
 * Validate a `/v2/snapshot` body before any value reaches the DOM. Returns null for a body that breaks the contract:
 * wrong version, a class A key anywhere, or a missing required part. Everything else is rebuilt from allowlists, the
 * 1.6 cross-field rules applied, and any value whose capability is absent removed (the honesty invariant, P3).
 */
export const parseSnapshotV2 = (value: unknown): SnapshotV2 | null => {
  const item = obj(value);
  if (!item || item.contractVersion !== CONTRACT_VERSION || classAKeys(item).length) return null;
  const serverNow = at(item.serverNow), service = obj(item.service), version = label(service?.version, 40), instance = hex8(service?.instance);
  const parsedConnection = connection(item.connection), parsedStatus = status(item.status), parsedRuntime = runtime(item.runtime);
  const parsedLease = lease(item.lease), marksHead = count(item.marksHead), nextPollMs = nonneg(item.nextPollMs);
  const host = item.host === null ? null : parseHostV2(item.host);
  if (serverNow === null || !version || !instance || !parsedConnection || !parsedStatus || !parsedRuntime || !obj(item.capabilities)
    || item.host !== null && !host || !parsedLease || marksHead === null || nextPollMs === null
    || !Array.isArray(item.alerts) || !Array.isArray(item.alertLog)) return null;
  const completions = parseCompletionsV2(item.completions, instance);
  if (!completions) return null;
  const snapshot: SnapshotV2 = defined({
    contractVersion: CONTRACT_VERSION, serverNow, service: { version, instance }, connection: parsedConnection, status: parsedStatus,
    capabilities: parseCapabilities(item.capabilities), runtime: parsedRuntime, host, completions, marksHead,
    alerts: parseAlerts(item.alerts), alertLog: parseAlertLog(item.alertLog), lease: parsedLease, nextPollMs,
    chat: item.chat === undefined ? undefined : parseChatMeasurement(item.chat, serverNow),
    mediaEnabled: opt(bool(item.mediaEnabled)),
    promptCache: item.promptCache === undefined ? undefined : parsePromptCache(item.promptCache, serverNow),
  });
  withhold(snapshot);
  return snapshot;
};
