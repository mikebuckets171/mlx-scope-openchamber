import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import { frameReading, fromSnapshot, type CatalogEntry, type PanelReason, type Reading, type ReadingPhase, type Resident } from '../present/reading.ts';

/** Projections retained by the unbundled 1.x capture/observation modules and their parity tests. */
export interface LegacyReading extends Reading {
  statsState: 'fresh' | 'stale' | 'unavailable';
  guardLevel: number | null;
  lastMissReason: 'empty_prompt' | 'no_recent_store_probe' | 'closest_recent_store' | null;
  averages: { decodeTps: number | null; prefillTps: number | null; cacheFraction: number | null } | null;
  lifetime: { requestsTotal: number | null; uptimeMs: number | null } | null;
  memory: { processBytes: number | null; modelBytes: number | null };
  cache: { ramBytes: number | null; ssdBytes: number | null } | null;
  residents: Resident[];
  residentCount: number | null;
  catalog: CatalogEntry[];
}

const phase = (value: string): ReadingPhase => value === 'not-loaded' ? 'notLoaded' : value === 'loading' ? 'unknown' : value as ReadingPhase;
const EMPTY_MEMORY = { processBytes: null, modelBytes: null };

/** Preserves the former flattening exactly, without importing its unused work into the shipping panel. */
export const legacyReading = (reading: Reading): LegacyReading => {
  const body = reading.body, runtime = body?.runtime;
  const result: LegacyReading = { ...reading, statsState: 'unavailable', guardLevel: null, lastMissReason: null,
    averages: null, lifetime: null, memory: EMPTY_MEMORY, cache: null,
    residents: [], residentCount: null,
    catalog: runtime?.catalog.map(entry => ({ name: entry.name, loaded: entry.loaded, format: entry.format, contextWindowTokens: entry.contextWindowTokens })) ?? [] };
  if (!reading.available || !body || !runtime) return result;
  const splash = body.connection.runtime === 'splash', averages = runtime.server.averages, cache = runtime.server.cache, memory = runtime.memory;
  const held = body.status.state === 'recovering' || body.status.reason === 'status_stale';
  return { ...result, statsState: averages ? held ? 'stale' : 'fresh' : 'unavailable',
    guardLevel: body.alerts.some(alert => alert.id === 'omlx-memory-guard') ? 1 : null,
    averages: splash ? null : { decodeTps: averages?.decodeTps ?? null, prefillTps: averages?.prefillTps ?? null, cacheFraction: averages?.cacheEfficiencyFraction ?? null },
    lifetime: !splash && (averages?.requestsTotal != null || averages?.uptimeMs != null)
      ? { requestsTotal: averages.requestsTotal ?? null, uptimeMs: averages.uptimeMs ?? null } : null,
    memory: { processBytes: memory.processBytes ?? null, modelBytes: memory.modelBytes ?? null },
    cache: [cache?.ramBytes, cache?.ramEntries, cache?.ssdBytes, cache?.ssdEntries].some(value => value != null)
      ? { ramBytes: cache?.ramBytes ?? null, ssdBytes: cache?.ssdBytes ?? null } : null,
    residents: runtime.residency.map(model => ({ model: model.model, phase: phase(model.phase), active: model.active ?? null, queued: model.queued ?? null,
      bytes: model.bytes ?? null, tps: model.decodeTps ?? model.prefillTps ?? null, prefillFraction: model.prefillFraction ?? null, stale: model.prefillStale === true })),
    residentCount: runtime.residencyCount ?? null };
};

export const legacyFromSnapshot = (body: SnapshotV2): LegacyReading => legacyReading(fromSnapshot(body));
export const legacyFrameReading = (reason: PanelReason, message: string | null, at: number): LegacyReading => legacyReading(frameReading(reason, message, at));
