import type { SystemSnapshot } from '../system.ts';
import type { TelemetryPhase, TelemetrySnapshot } from '../telemetry.ts';
import type { AlertLogEntryV2, AlertV2 } from './alerts.ts';
import { capabilitiesOf, type Basis, type CapabilityDescriptor, type CapabilityKey } from './capabilities.ts';
import { CONNECTION_ID, type Json } from './guards.ts';
import type { StatusReason, StatusState } from './reasons.ts';
import { parseSnapshotV2, requiredCapabilities, type CompatV1, type ConnectionV2, type LeaseV2, type Phase, type SnapshotV2 } from './snapshot.ts';
import { gbToBytes, percentToFraction, secondsToMs } from './units.ts';
import { CONTRACT_VERSION } from './version.ts';

/**
 * Stage 2a bridge: today's 1.x reading (runtime adapters plus the host sampler) as a v2 body, with nothing the 1.6
 * panel renders lost. Decimal GB becomes integer bytes, seconds become ms, percents become fractions; what v2 has no
 * field for rides in `compat`. Pure: the service supplies its identity and scheduling in `extras`.
 */
export type V1Snapshot = TelemetrySnapshot & { system?: SystemSnapshot | null };
export interface V1Extras {
  service: { version: string; instance: string };
  serverNow?: number;                        // default: the reading's sampledAt
  generation?: number;                       // default: 1 when the 1.x slot had a generation, else 0
  detection?: ConnectionV2['detection'];     // default: a low-confidence probe, the weakest claim
  runtimeVersion?: string;
  completionSeq?: number;                    // seq for the 1.x lastRequest; default 1
  marksHead?: number;
  alerts?: AlertV2[];
  alertLog?: AlertLogEntryV2[];
  lease?: LeaseV2;
  nextPollMs?: number;                       // default: the 1.6 cadence, 500 ms while active, else 2 s
}

const R: Basis = 'reported', D: Basis = 'derived', O: Basis = 'observed', E: Basis = 'estimate';
type Table = Partial<Record<CapabilityKey, Basis>>;
const REQUEST: Table = { 'request.decodeRate': R, 'request.prefillRate': R, 'request.prefillProgress': R, 'request.prefillEta': E,
  'request.tokens': R, 'request.elapsed': R, 'request.context': D };
/** What each 1.6 adapter can report, and how (contract §4 basis). Context used is prompt + output: derived. */
const adapterCapabilities = (runtime: string | null, coverage: string | null | undefined): Table => {
  switch (runtime) {
    case 'omlx': return { ...REQUEST, 'server.requests': R, 'server.averages': R, 'server.cache': R,
      'server.memory.process': R, 'server.memory.model': R, 'server.residency': R };
    case 'lmstudio': return { 'server.residency': R, 'server.catalog': R, ...coverage === 'requests' ? {
      // Scope tallies the log stream's start and Done lines, so counts and elapsed time are its own observation;
      // averages are computed from the runtime's per-request figures.
      'server.requests': O, 'request.prefillProgress': R, 'request.elapsed': O, 'server.averages': D, 'server.completions': R } : {} };
    // Splash counts in-flight work as submitted − completed − failed − cancelled.
    case 'splash': return { 'server.requests': D, 'server.averages': R, 'server.memory.metal': R, 'server.catalog': R };
    case 'vllm-mlx': return { 'server.catalog': R, ...coverage === 'requests' ? { ...REQUEST, 'server.requests': R, 'server.averages': R,
      'server.cache': R } : {} };
    case 'mlx-lm': return { 'server.catalog': R };
    default: return {};
  }
};

const phase = (value: TelemetryPhase): Phase =>
  value === 'notLoaded' ? 'not-loaded' : value === 'connecting' || value === 'reconnecting' || value === 'offline' ? 'unknown' : value;
const FRAME_PHASES = new Set<TelemetryPhase>(['connecting', 'reconnecting', 'offline']);
const ACTIVE = new Set<TelemetryPhase>(['decode', 'prefill', 'processing', 'queued']);
const valid = (n: number | null): n is number => n !== null && Number.isSafeInteger(n) && n >= 0;
/** A group with no reading is absent, so it never claims a capability. */
const some = (group: Json): Json | null => Object.values(group).some(value => value != null) ? group : null;

/** 1.6 `status` semantics: unavailable is failing, except a missing or unreadable configuration. */
const status = (v1: V1Snapshot): { state: StatusState; reason: StatusReason | null } => {
  if (v1.available) return v1.runtime === 'splash' && v1.serverStats?.ready === false ? { state: 'degraded', reason: 'loading' } : { state: 'ready', reason: null };
  if (v1.reason === 'runtime_unreachable' && ['missing', 'invalid', 'unreadable'].includes(v1.connection?.diagnostic ?? '')) {
    return { state: 'unconfigured', reason: 'configuration_missing' };
  }
  const reason = v1.reason === 'runtime_unreachable' || v1.reason === 'authentication_failed' || v1.reason === 'unsupported_contract' ? v1.reason : null;
  return { state: 'failing', reason };
};
/** The 1.6 reason `status` stands for; `compat.reason` carries any other. */
export const v1Reason = (state: StatusState, reason: StatusReason | null): V1Snapshot['reason'] =>
  state === 'ready' || state === 'degraded' ? null : reason === 'configuration_missing' ? 'runtime_unreachable'
    : reason === 'runtime_unreachable' || reason === 'authentication_failed' || reason === 'unsupported_contract' ? reason : null;

/** Mirrors panel/context.ts: reported prompt + output against the model limit, only where 1.6 shows it. */
const contextUsed = (v1: V1Snapshot): number | null => {
  if (!['prefill', 'decode', 'processing'].includes(v1.phase) || (v1.activeRequests ?? 0) > 1) return null;
  const prompt = v1.promptTokens, limit = v1.contextWindow, output = v1.phase === 'prefill' ? 0 : v1.completionTokens;
  if (!valid(prompt) || !valid(limit) || limit === 0 || !valid(output)) return null;
  const used = prompt + output;
  return Number.isSafeInteger(used) && used <= limit ? used : null;
};

const request = (v1: V1Snapshot): Json | null => {
  const reading = {
    decodeTps: v1.liveDecodeTPS, prefillTps: v1.livePrefillTPS, prefillProcessedTokens: v1.prefillProcessedTokens,
    prefillTotalTokens: v1.prefillTotalTokens, prefillFraction: v1.prefillProgress, prefillStale: v1.prefillProgressStale || null,
    prefillEtaMs: secondsToMs(v1.prefillETASeconds), promptTokens: v1.promptTokens, cachedTokens: v1.cachedTokens,
    outputTokens: v1.completionTokens, elapsedMs: secondsToMs(v1.elapsedSeconds), contextUsedTokens: contextUsed(v1),
  };
  return Object.values(reading).some(value => value != null)
    ? { model: v1.modelID, ...reading, contextWindowTokens: v1.contextWindow } : null;
};

const runtime = (v1: V1Snapshot): Json => {
  const available = v1.available, splash = v1.runtime === 'splash', stats = v1.serverStats, bank = v1.sessionBank;
  return {
    sampledAt: v1.sampledAt, phase: available ? phase(v1.phase) : 'unknown', request: available ? request(v1) : null,
    server: available ? {
      active: v1.activeRequests, queued: v1.queuedRequests,
      averages: some(splash ? { decodeTps: stats?.aggregateDecodeTokensPerSecond, requestsTotal: stats?.completedRequests, failedTotal: stats?.failedRequests }
        : { decodeTps: v1.sessionAverageDecodeTPS, prefillTps: v1.sessionAveragePrefillTPS,
          cacheEfficiencyFraction: percentToFraction(v1.sessionCacheEfficiencyPercent), requestsTotal: v1.lifetime?.requestsTotal,
          uptimeMs: secondsToMs(v1.lifetime?.uptimeSeconds) }),
      cache: bank && some({ ramBytes: gbToBytes(bank.hot?.totalGB), ramEntries: bank.hot?.entries, ssdBytes: gbToBytes(bank.cold?.totalGB),
        ssdEntries: bank.cold?.entries }),
    } : { active: null, queued: null },
    memory: available ? { processBytes: gbToBytes(v1.memory?.activeGB), modelBytes: gbToBytes(v1.memory?.modelGB),
      metalBytes: splash ? gbToBytes(stats?.metalCurrentGB) : null, metalPeakBytes: splash ? gbToBytes(stats?.metalPeakGB) : null } : {},
    residency: available ? v1.residentModels.map(model => ({
      model: model.id, phase: phase(model.phase), source: 'runtime', active: model.activeRequests, queued: model.queuedRequests,
      bytes: gbToBytes(model.allocationGB), prefillFraction: model.prefillProgress, prefillStale: model.progressStale || null,
      [model.phase === 'prefill' ? 'prefillTps' : 'decodeTps']: model.tokensPerSecond,
    })) : [],
    residencyCount: available ? v1.residentModelCount : null,
    slots: [], engines: [],
    catalog: (v1.catalog ?? []).map(model => ({ name: model.name, format: model.format, loaded: model.loaded, contextWindowTokens: model.contextWindow })),
  };
};

const PLATFORMS: Record<string, string> = { darwin: 'macOS', macOS: 'macOS', linux: 'Linux', Linux: 'Linux', win32: 'Windows', Windows: 'Windows' };
const host = (system: SystemSnapshot | null | undefined): Json | null => {
  // The 1.6 parser drops a host reading without a platform or a sample time; so does the bridge.
  if (!system || typeof system.platform !== 'string' || !Number.isFinite(system.sampledAt) || system.sampledAt < 0) return null;
  const platform = Object.hasOwn(PLATFORMS, system.platform) ? PLATFORMS[system.platform]! : 'Host', mac = system.macOS;
  return {
    sampledAt: system.sampledAt, platform, cpuModel: system.cpuModel, logicalCores: system.logicalCores,
    cpuFraction: percentToFraction(system.cpuPercent), memTotalBytes: gbToBytes(system.memoryTotalGB), memUsedBytes: gbToBytes(system.memoryUsedGB),
    mac: platform === 'macOS' && mac ? { sampledAt: mac.sampledAt, wiredBytes: gbToBytes(mac.wiredGB),
      compressedBytes: gbToBytes(mac.compressedGB), swapUsedBytes: gbToBytes(mac.swapUsedGB) } : null,
  };
};

const compat = (v1: V1Snapshot, connectionRuntime: string | null, state: ReturnType<typeof status>): CompatV1 => {
  const available = v1.available, link = v1.connection;
  const reason = v1Reason(state.state, state.reason) === v1.reason ? undefined : v1.reason ?? undefined;
  return {
    message: v1.message, ...reason ? { reason } : {},
    ...available && FRAME_PHASES.has(v1.phase) ? { phase: v1.phase as CompatV1['phase'] } : {},
    ...available && v1.runtime !== connectionRuntime ? { runtime: v1.runtime } : {},
    connection: link ? { selected: link.selected, generation: link.generation ?? null, diagnostic: link.diagnostic, coverage: link.coverage } : null,
    modelID: available ? v1.modelID : null, contextWindow: available ? v1.contextWindow : null,
    statsState: available ? v1.sessionStatsState : 'unavailable', guardLevel: available ? v1.memoryPressureLevel : null,
    lastMissReason: available ? v1.sessionBank?.lastMissReason as CompatV1['lastMissReason'] ?? null : null,
    traceEpoch: available ? v1.traceEpoch : null,
  };
};

/** The body before validation, and any capability the adapter table missed. `toSnapshotV2` parses the body. */
const draft = (v1: V1Snapshot, extras: V1Extras): { body: Json; uncovered: CapabilityKey[] } => {
  const link = v1.connection ?? null, state = status(v1);
  const connectionRuntime = link ? link.runtime : v1.runtime;
  const body: Json = {
    contractVersion: CONTRACT_VERSION, serverNow: extras.serverNow ?? v1.sampledAt, service: extras.service,
    connection: {
      // The grammar is narrower than 1.x ids; 'auto' stands for "nothing selected", as in the G2 mock.
      id: link?.selected && CONNECTION_ID.test(link.selected) ? link.selected : 'auto', label: link?.label ?? 'Automatic',
      runtime: connectionRuntime, version: extras.runtimeVersion, engine: link?.engine ?? null, host: link?.host ?? null,
      generation: extras.generation ?? (link?.generation ? 1 : 0), choices: link?.choices ?? [],
      detection: extras.detection ?? { basis: 'probe', confidence: 'low' },
    },
    status: { ...state, params: {} },
    runtime: runtime(v1), host: host(v1.system),
    completions: { instance: extras.service.instance, cursor: 0, reset: false, items: [] },
    marksHead: extras.marksHead ?? 0, alerts: extras.alerts ?? [], alertLog: extras.alertLog ?? [],
    lease: extras.lease ?? { leader: true, epoch: 0, ttlMs: 12_000, leaderSurface: null },
    nextPollMs: extras.nextPollMs ?? (v1.available && ACTIVE.has(v1.phase) ? 500 : 2_000),
    compat: compat(v1, connectionRuntime, state),
  };
  const last = v1.available ? v1.lastRequest : null;
  if (last) {
    const seq = extras.completionSeq ?? 1;
    // 1.x never tracked overlap; true keeps the row server-wide and out of per-request baselines (P4).
    body.completions = { instance: extras.service.instance, cursor: seq, reset: false, items: [{ seq, finishedAt: last.finishedAt, startedAt: null,
      model: last.model, basis: 'reported', promptTokens: last.promptTokens, cachedTokens: last.cachedTokens, outputTokens: last.outputTokens,
      ttftMs: secondsToMs(last.ttftSeconds), decodeTps: last.tokensPerSecond, overlapped: true, host: {} }] };
  }
  const table: Table = {
    ...v1.available ? adapterCapabilities(v1.runtime ?? connectionRuntime, link?.coverage) : {},
    ...v1.catalog?.length ? { 'server.catalog': R } : {},
    ...body.host ? { 'host.cpu': R, 'host.memory': R, ...(body.host as Json).mac ? { 'host.swap': R } : {} } : {},
  };
  // A value the adapter sent without a table entry was still reported by the runtime (1.6 labelled everything else).
  const uncovered = requiredCapabilities(body).filter(key => !table[key]);
  for (const key of uncovered) table[key] = R;
  body.capabilities = capabilitiesOf(Object.entries(table).map(([key, basis]): CapabilityDescriptor => ({ key: key as CapabilityKey, basis: basis! })));
  return { body, uncovered };
};

export const toSnapshotV2 = (v1: V1Snapshot, extras: V1Extras): SnapshotV2 => {
  const snapshot = parseSnapshotV2(draft(v1, extras).body);
  if (!snapshot) throw new TypeError('The 1.x reading could not form a v2 snapshot; check extras.service.');
  return snapshot;
};

export const __test__ = { draft };
