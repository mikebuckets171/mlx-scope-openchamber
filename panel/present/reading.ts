import { v1Reason } from '../../src/contract/convert-v1.ts';
import type { RuntimeKind } from '../../src/contract/runtime.ts';
import type { RequestV2, SnapshotV2, V1_DIAGNOSTICS, V1_LOOKUP_REASONS, V1_REASONS, V1_STATS_STATES } from '../../src/contract/snapshot.ts';

/**
 * What the presenters read: one validated `/v2/snapshot` body flattened to the values the panel shows, or a
 * frame-side state (a host error, a contract mismatch, a missed deadline) that has no body. Units stay v2 (bytes,
 * ms, fractions); only the vocabulary is the panel's. Nothing is read from `compat`: the 2.0 panel consumes v2 natively.
 */
export type PanelReason = typeof V1_REASONS[number] | 'contract_mismatch' | 'needs_approval';
export type ReadingPhase = 'connecting' | 'reconnecting' | 'offline' | 'notLoaded' | 'idle' | 'queued' | 'prefill' | 'decode' | 'processing' | 'unknown';
export type Coverage = 'requests' | 'inventory' | 'server';
export type Choice = { id: string; label: string; runtime: RuntimeKind | null };
export interface Link {
  selected: string | null; label: string | null; runtime: RuntimeKind | null; generation: string | number | null;
  choices: Choice[]; diagnostic: typeof V1_DIAGNOSTICS[number]; coverage: Coverage | null;
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
  statsState: typeof V1_STATS_STATES[number];
  guardLevel: number | null;                 // oMLX process memory guard, not macOS pressure
  traceEpoch: number | null;
  lastMissReason: typeof V1_LOOKUP_REASONS[number] | null;
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

const link = (body: SnapshotV2): Link => {
  const connection = body.connection, can = body.capabilities, selected = connection.id === 'auto' ? null : connection.id;
  const coverage: Coverage = can['request.decodeRate'] || can['request.prefillProgress'] ? 'requests' : can['server.catalog'] && !can['server.requests'] ? 'inventory' : 'server';
  return { runtime: connection.runtime, choices: connection.choices, engine: connection.engine ?? null, host: connection.host ?? null,
    selected, label: selected === null ? null : connection.label, generation: connection.generation,
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

/** The body's values for the modules kept from 1.6 (report, capture, signal): an unavailable reading keeps only its connection,
 *  catalog and host. The 2.0 views read the body itself. */
export const fromSnapshot = (body: SnapshotV2): Reading => {
  const available = AVAILABLE.has(body.status.state), runtime = body.runtime;
  const reading: Reading = {
    ...frameReading(v1Reason(body.status.state, body.status.reason) ?? 'unparseable_snapshot', null, runtime.sampledAt ?? body.serverNow),
    body, link: link(body), host: host(body),
    catalog: runtime.catalog.map(entry => ({ name: entry.name, loaded: entry.loaded, format: entry.format, contextWindowTokens: entry.contextWindowTokens })),
  };
  if (!available) return reading;
  const which = body.connection.runtime, held = body.status.state === 'recovering' || body.status.reason === 'status_stale';
  const splash = which === 'splash', averages = runtime.server.averages, cache = runtime.server.cache, memory = runtime.memory;
  const loaded = runtime.catalog.find(model => model.loaded);
  return {
    ...reading, available: true, reason: null, runtime: which, phase: phase(runtime.phase),
    model: runtime.request?.model ?? runtime.residency[0]?.model ?? loaded?.name ?? null,
    contextWindowTokens: runtime.request?.contextWindowTokens ?? runtime.residency.find(model => model.contextWindowTokens)?.contextWindowTokens ?? loaded?.contextWindowTokens ?? null,
    statsState: averages ? held ? 'stale' : 'fresh' : 'unavailable', guardLevel: body.alerts.some(alert => alert.id === 'omlx-memory-guard') ? 1 : null,
    // The connection generation is v2's continuity counter: a change means a new stream of readings.
    traceEpoch: body.connection.generation, lastMissReason: null,
    request: runtime.request, active: runtime.server.active, queued: runtime.server.queued,
    averages: splash ? null : { decodeTps: averages?.decodeTps ?? null, prefillTps: averages?.prefillTps ?? null, cacheFraction: averages?.cacheEfficiencyFraction ?? null },
    lifetime: !splash && (averages?.requestsTotal != null || averages?.uptimeMs != null)
      ? { requestsTotal: averages.requestsTotal ?? null, uptimeMs: averages.uptimeMs ?? null } : null,
    splash: splash ? { ready: body.status.reason !== 'loading', decodeTps: averages?.decodeTps ?? null, completed: averages?.requestsTotal ?? null,
      failed: averages?.failedTotal ?? null, metalBytes: memory.metalBytes ?? null, metalPeakBytes: memory.metalPeakBytes ?? null } : null,
    memory: { processBytes: memory.processBytes ?? null, modelBytes: memory.modelBytes ?? null },
    cache: [cache?.ramBytes, cache?.ramEntries, cache?.ssdBytes, cache?.ssdEntries].some(value => value != null)
      ? { ramBytes: cache?.ramBytes ?? null, ssdBytes: cache?.ssdBytes ?? null } : null,
    residents: runtime.residency.map(model => ({ model: model.model, phase: phase(model.phase), active: model.active ?? null, queued: model.queued ?? null,
      bytes: model.bytes ?? null, tps: model.decodeTps ?? model.prefillTps ?? null, prefillFraction: model.prefillFraction ?? null, stale: model.prefillStale === true })),
    residentCount: runtime.residencyCount ?? null,
  };
};

/** A connection's identity: a change clears every observation made for the previous one. */
export const linkIdentity = (value: Link): string => JSON.stringify([value.selected, value.runtime, value.generation]);
