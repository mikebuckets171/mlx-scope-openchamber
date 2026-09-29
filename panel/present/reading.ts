import { v1Reason } from '../../src/contract/convert-v1.ts';
import type { RuntimeKind } from '../../src/contract/runtime.ts';
import type { CompatV1, RequestV2, SnapshotV2, V1_REASONS } from '../../src/contract/snapshot.ts';

/**
 * What the presenters read: one validated `/v2/snapshot` body flattened to the values the panel shows, or a
 * frame-side state (a host error, a contract mismatch, a missed deadline) that has no body. Units stay v2 (bytes,
 * ms, fractions); only the vocabulary is the panel's. Stage 2a reads the 1.6 meanings the service still sends in
 * `compat`; Stage 2b replaces each with its v2 field.
 */
export type PanelReason = typeof V1_REASONS[number] | 'contract_mismatch';
export type ReadingPhase = 'connecting' | 'reconnecting' | 'offline' | 'notLoaded' | 'idle' | 'queued' | 'prefill' | 'decode' | 'processing' | 'unknown';
export type Coverage = 'requests' | 'inventory' | 'server';
export type Choice = { id: string; label: string; runtime: RuntimeKind | null };
export interface Link {
  selected: string | null; label: string | null; runtime: RuntimeKind | null; generation: string | number | null;
  choices: Choice[]; diagnostic: NonNullable<CompatV1['connection']>['diagnostic']; coverage: Coverage | null;
  engine: 'splash' | null; host: 'bionic' | null;
}
export interface SplashStats { ready: boolean; decodeTps: number | null; completed: number | null; failed: number | null; metalBytes: number | null; metalPeakBytes: number | null }
export interface Resident { model: string; phase: ReadingPhase; active: number | null; queued: number | null; bytes: number | null; tps: number | null; prefillFraction: number | null; stale: boolean }
export interface CatalogEntry { name: string; loaded: boolean | null; format: 'mlx' | 'gguf' | 'splash' | null; contextWindowTokens: number | null }
export interface MacReading { wiredBytes: number | null; compressedBytes: number | null; swapUsedBytes: number | null; sampledAt: number }
export interface HostReading {
  platform: 'macOS' | 'Linux' | 'Windows' | 'Host'; cpuModel: string | null; logicalCores: number | null;
  cpuPercent: number | null; memUsedBytes: number | null; memTotalBytes: number | null; mac: MacReading | null; sampledAt: number;
}
export interface Reading {
  body: SnapshotV2 | null;
  available: boolean;
  reason: PanelReason | null;                // null exactly when available
  message: string | null;
  sampledAt: number;                         // the runtime reading's time on the service clock, or the frame's time
  runtime: RuntimeKind | null;               // what the reading is from; null while unavailable
  link: Link | null;                         // the selected connection, when the service described one
  phase: ReadingPhase;
  model: string | null;                      // the headline model, also while idle
  contextWindowTokens: number | null;
  statsState: CompatV1['statsState'];
  guardLevel: number | null;                 // oMLX process memory guard, not macOS pressure
  traceEpoch: number | null;
  lastMissReason: CompatV1['lastMissReason'];
  request: RequestV2 | null;
  active: number | null;
  queued: number | null;
  averages: { decodeTps: number | null; prefillTps: number | null; cacheFraction: number | null } | null;   // not Splash
  lifetime: { requestsTotal: number | null; uptimeMs: number | null } | null;                             // not Splash
  splash: SplashStats | null;
  memory: { processBytes: number | null; modelBytes: number | null };
  cache: { ramBytes: number | null; ssdBytes: number | null } | null;
  residents: Resident[];
  residentCount: number | null;
  catalog: CatalogEntry[];
  host: HostReading | null;
}

const EMPTY_MEMORY = { processBytes: null, modelBytes: null };
export const frameReading = (reason: PanelReason, message: string | null, at: number): Reading => ({
  body: null, available: false, reason, message: message?.trim() || null, sampledAt: at, runtime: null, link: null, phase: 'unknown',
  model: null, contextWindowTokens: null, statsState: 'unavailable', guardLevel: null, traceEpoch: null, lastMissReason: null,
  request: null, active: null, queued: null, averages: null, lifetime: null, splash: null, memory: EMPTY_MEMORY, cache: null,
  residents: [], residentCount: null, catalog: [], host: null,
});

const phase = (value: string): ReadingPhase => value === 'not-loaded' ? 'notLoaded' : value === 'loading' ? 'unknown' : value as ReadingPhase;
const AVAILABLE = new Set(['ready', 'degraded']);

const link = (body: SnapshotV2): Link | null => {
  const connection = body.connection, compat = body.compat;
  const shared = { runtime: connection.runtime, choices: connection.choices, engine: connection.engine ?? null, host: connection.host ?? null };
  if (compat) {
    const known = compat.connection;
    return known && { ...shared, selected: known.selected, label: known.selected === null ? null : connection.label, generation: known.generation,
      diagnostic: known.diagnostic, coverage: known.coverage };
  }
  // A v2 body without the 1.6 bridge: describe what v2 says, with coverage from the declared capabilities.
  const can = body.capabilities, selected = connection.id === 'auto' ? null : connection.id;
  const coverage: Coverage = can['request.decodeRate'] || can['request.prefillProgress'] ? 'requests' : can['server.catalog'] && !can['server.requests'] ? 'inventory' : 'server';
  return { ...shared, selected, label: selected === null ? null : connection.label, generation: connection.generation,
    diagnostic: AVAILABLE.has(body.status.state) ? 'ready' : 'offline', coverage };
};

const host = (body: SnapshotV2): HostReading | null => {
  const reading = body.host;
  if (!reading) return null;
  const platform = reading.platform ?? 'Host', mac = platform === 'macOS' ? reading.mac : undefined;
  return {
    platform, cpuModel: reading.cpuModel ?? null, logicalCores: reading.logicalCores ?? null,
    cpuPercent: reading.cpuFraction == null ? null : reading.cpuFraction * 100,
    memUsedBytes: reading.memUsedBytes ?? null, memTotalBytes: reading.memTotalBytes ?? null, sampledAt: reading.sampledAt,
    mac: mac ? { wiredBytes: mac.wiredBytes ?? null, compressedBytes: mac.compressedBytes ?? null, swapUsedBytes: mac.swapUsedBytes ?? null, sampledAt: mac.sampledAt } : null,
  };
};

/** The body's values with 1.6 availability rules: an unavailable reading keeps only its connection, catalog and host. */
export const fromSnapshot = (body: SnapshotV2): Reading => {
  const compat = body.compat, available = AVAILABLE.has(body.status.state), runtime = body.runtime;
  const reading: Reading = {
    ...frameReading(compat?.reason ?? v1Reason(body.status.state, body.status.reason) ?? 'unparseable_snapshot', compat?.message ?? null,
      runtime.sampledAt ?? body.serverNow),
    body, link: link(body), host: host(body),
    catalog: runtime.catalog.map(entry => ({ name: entry.name, loaded: entry.loaded, format: entry.format, contextWindowTokens: entry.contextWindowTokens })),
  };
  if (!available) return reading;
  const which = compat && compat.runtime !== undefined ? compat.runtime : body.connection.runtime;
  const splash = which === 'splash', averages = runtime.server.averages, cache = runtime.server.cache, memory = runtime.memory;
  return {
    ...reading, available: true, reason: null, runtime: which,
    phase: compat?.phase ?? phase(runtime.phase), model: compat ? compat.modelID : runtime.request?.model ?? null,
    contextWindowTokens: compat ? compat.contextWindow : runtime.request?.contextWindowTokens ?? null,
    statsState: compat?.statsState ?? (averages ? 'fresh' : 'unavailable'), guardLevel: compat?.guardLevel ?? null,
    traceEpoch: compat?.traceEpoch ?? null, lastMissReason: compat?.lastMissReason ?? null,
    request: runtime.request, active: runtime.server.active, queued: runtime.server.queued,
    averages: splash ? null : { decodeTps: averages?.decodeTps ?? null, prefillTps: averages?.prefillTps ?? null, cacheFraction: averages?.cacheEfficiencyFraction ?? null },
    lifetime: !splash && (averages?.requestsTotal != null || averages?.uptimeMs != null)
      ? { requestsTotal: averages.requestsTotal ?? null, uptimeMs: averages.uptimeMs ?? null } : null,
    splash: splash ? { ready: body.status.reason !== 'loading', decodeTps: averages?.decodeTps ?? null, completed: averages?.requestsTotal ?? null,
      failed: averages?.failedTotal ?? null, metalBytes: memory.metalBytes ?? null, metalPeakBytes: memory.metalPeakBytes ?? null } : null,
    memory: { processBytes: memory.processBytes ?? null, modelBytes: memory.modelBytes ?? null },
    cache: [cache?.ramBytes, cache?.ramEntries, cache?.ssdBytes, cache?.ssdEntries, compat?.lastMissReason].some(value => value != null)
      ? { ramBytes: cache?.ramBytes ?? null, ssdBytes: cache?.ssdBytes ?? null } : null,
    residents: runtime.residency.map(model => ({ model: model.model, phase: phase(model.phase), active: model.active ?? null, queued: model.queued ?? null,
      bytes: model.bytes ?? null, tps: model.decodeTps ?? model.prefillTps ?? null, prefillFraction: model.prefillFraction ?? null, stale: model.prefillStale === true })),
    residentCount: runtime.residencyCount ?? null,
  };
};

/** A connection's identity: a change clears every observation made for the previous one. */
export const linkIdentity = (value: Link): string => JSON.stringify([value.selected, value.runtime, value.generation]);
