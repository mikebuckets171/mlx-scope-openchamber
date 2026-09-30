import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { version as packageVersion } from '../package.json';
import { assertBodyLimit } from '../src/contract/guards.ts';
import type { HostV2 } from '../src/contract/host.ts';
import { isBadQuery, parseSnapshotQuery, parseTrendQuery, parseUsageQuery, type TrendQuery, type UsageQuery } from '../src/contract/query.ts';
import type { TrendV2 } from '../src/contract/trend.ts';
import type { UsageV2 } from '../src/contract/usage.ts';
import { healthBody, NOT_FOUND_BODY, RETIRED_BODY, RETIRED_STATUS, ROUTES } from '../src/contract/version.ts';
import { composeSnapshot, snapshotPollMs } from './core/compose.ts';
import { Lease } from './core/lease.ts';
import { ENERGY_FLOOR_MS } from './core/scheduler.ts';
import { Marks, type TurnMark } from './core/marks.ts';
import { Verdicts } from './core/verdicts.ts';
import type { HostContext } from './host/sampler.ts';
import type { HistoryReading, SnapshotHistory, RecordContext } from './history/history.ts';
import { busy, type ReadRequest, type ReadSelection, type RuntimeReading } from './runtime-client.ts';

export type Sources = {
  read: (selection?: ReadSelection, request?: ReadRequest) => Promise<RuntimeReading>;
  /** Host readings for this request's tier (svc-host's HostSampler.sample). */
  host?: (context: HostContext) => Promise<HostV2 | null>;
  /**
   * The per-slot rings, detectors and alert book (svc-history's ServiceHistory): fed once per request after the
   * collection, read for the body's completions and alerts; `head` bounds the verdicts frames may send. Absent → none.
   */
  history?: {
    readonly head: number;
    record(key: string, reading: HistoryReading, host: HostV2 | null, context: RecordContext): void;
    snapshot(key: string, options: { since?: number; leader: boolean; now: number; verdict: (seq: number) => ReturnType<Verdicts['get']> }): SnapshotHistory;
  };
  /** `/v2/trend` and `/v2/usage` bodies (svc-history, the oMLX read-through); absent → 501. */
  trend?: (query: TrendQuery, context: { marks: readonly TurnMark[]; now: number }) => Promise<TrendV2>;
  usage?: (query: UsageQuery) => Promise<UsageV2>;
};
export type ServerOptions = { version?: string; instance?: string; now?: () => number; monotonic?: () => number };

/** Every body is checked against the SDK response limit before a header is written. */
export const encode = (body: unknown): string => assertBodyLimit(body);
const json = (response: http.ServerResponse, status: number, body: unknown): void => {
  const text = encode(body);
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  response.end(text);
};
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
const NOT_IMPLEMENTED = { error: 'not_implemented' } as const;
/** A slot key for readings no connection slot serves (unconfigured, deferred): host alerts still need a history. */
const UNSLOTTED = '\u0000unslotted';
/** oMLX's memory guard tier as the alert book counts it (1.6 levels: ok 0, soft 1, hard 2). */
const GUARD_LEVEL = { ok: 0, soft: 1, hard: 2 } as const;
/** What the history needs from one reading: the adapter's own parts, never the service's meta. */
export const historyReading = (reading: RuntimeReading): HistoryReading => {
  const guard = reading.runtime.memory.guard;
  return { at: reading.at, kind: reading.meta.connection.runtime, status: reading.status, capabilities: reading.capabilities,
    runtime: reading.runtime, completions: reading.completions, ...guard ? { guardLevel: GUARD_LEVEL[guard] } : {} };
};

/** A reading the collector could not produce at all: nothing about the runtime is known, so nothing is claimed. */
export const unread = (at: number): RuntimeReading => ({
  at, status: { state: 'failing', reason: 'runtime_unreachable', params: {} }, capabilities: {}, identity: {}, completions: [],
  runtime: { phase: 'unknown', request: null, server: { active: null, queued: null }, memory: {}, residency: [], slots: [], catalog: [], engines: [] },
  meta: { connection: { id: 'auto', label: 'Automatic', runtime: null, generation: 0, choices: [], detection: { basis: 'probe', confidence: 'low' } },
    port: null, slot: null, failures: 0, idleMs: 0, cadenceMs: 2_000 },
});

/**
 * What the host sampler rides along with: the frame's tier, whether the runtime is working, and the oMLX loopback port
 * only while oMLX itself answered on it, so lsof and footprint never read whatever else holds that port.
 */
export const hostContextOf = (tier: HostContext['tier'], { status, runtime, meta }: RuntimeReading): HostContext => ({
  tier, active: busy(runtime), generation: meta.connection.generation,
  omlxPort: meta.connection.runtime === 'omlx' && (status.state === 'ready' || status.state === 'degraded') ? meta.port ?? null : null,
});

/** Exact read-only route allowlist (contract §2). Host and inference failures are independent. */
export const createScopeServer = (token: string, sources: Sources, options: ServerOptions = {}): http.Server => {
  if (!token) throw new Error('A service token is required.');
  // Equal-length digests make the comparison constant-time whatever the header holds.
  const expected = digest(`Bearer ${token}`);
  const service = { version: options.version ?? packageVersion, instance: options.instance ?? randomBytes(4).toString('hex') };
  const now = options.now ?? Date.now, monotonic = options.monotonic ?? (() => performance.now());
  const lease = new Lease(), marks = new Marks(), verdicts = new Verdicts();
  return http.createServer((request, response) => {
    const handle = async (): Promise<void> => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const header = request.headers.authorization;
      if (typeof header !== 'string' || !timingSafeEqual(digest(header), expected)) { json(response, 401, { error: 'unauthorized' }); return; }
      if (request.method !== 'GET') { json(response, 405, { error: 'method_not_allowed' }); return; }
      if (url.pathname === ROUTES.health) { json(response, 200, healthBody(service.version)); return; }
      if (url.pathname === ROUTES.retired) { json(response, RETIRED_STATUS, RETIRED_BODY); return; }
      if (url.pathname === ROUTES.trend || url.pathname === ROUTES.usage) {
        // Validated now so frames built against these routes fail the same way once they are served (Stage 6).
        if (url.pathname === ROUTES.trend) {
          const query = parseTrendQuery(url.searchParams);
          if (isBadQuery(query)) json(response, 400, query);
          else if (sources.trend) json(response, 200, await sources.trend(query, { marks: marks.entries(), now: now() }));
          else json(response, 501, NOT_IMPLEMENTED);
        } else {
          const query = parseUsageQuery(url.searchParams);
          if (isBadQuery(query)) json(response, 400, query);
          else if (sources.usage) json(response, 200, await sources.usage(query)); else json(response, 501, NOT_IMPLEMENTED);
        }
        return;
      }
      if (url.pathname !== ROUTES.snapshot) { json(response, 404, NOT_FOUND_BODY); return; }
      const query = parseSnapshotQuery(url.searchParams);
      if (isBadQuery(query)) { json(response, 400, query); return; }
      const serverNow = now();
      marks.record(query.marks, serverNow);
      verdicts.record(query.attrs, serverNow, sources.history?.head ?? 0);
      const view = lease.observe(query.frame, query.surface, monotonic());
      // 1.6 semantics: provider '' with a runtime is "Automatic, read as that runtime".
      const selection = query.provider || query.runtime ? { provider: query.provider ?? '', runtime: query.runtime ?? null } : undefined;
      const reading = await Promise.resolve().then(() => sources.read(selection, { tier: query.tier, detail: query.detail === 'server' }))
        .catch(() => unread(serverNow));
      const context = hostContextOf(query.tier, reading);
      const host = await Promise.resolve().then(() => sources.host?.(context) ?? null).catch(() => null);
      const pollMs = snapshotPollMs({ reading, host, lease: view, query });
      let parts: SnapshotHistory = { completions: { instance: service.instance, cursor: 0, reset: query.since !== undefined && query.since > 0, items: [] },
        alerts: [], alertLog: [] };
      if (sources.history) {
        const key = reading.meta.slot ?? UNSLOTTED;
        // The slot's segments follow the slowest reader: the cadence handed to this frame, the adapter's own, or the
        // Energy-saving floor the frame may apply on top (the service cannot tell whether it does).
        const floorMs = query.surface ? ENERGY_FLOOR_MS[query.surface] ?? 0 : 0;
        sources.history.record(key, historyReading(reading), host, { now: serverNow, pollMs: Math.max(pollMs, reading.meta.cadenceMs, floorMs),
          selection: { ...query.provider !== undefined ? { provider: query.provider } : {}, ...query.runtime ? { runtime: query.runtime } : {} } });
        parts = sources.history.snapshot(key, { since: query.since, leader: view.leader, now: serverNow, verdict: seq => verdicts.get(seq) });
      }
      json(response, 200, composeSnapshot({
        reading, host, completions: parts.completions, alerts: { alerts: parts.alerts, alertLog: parts.alertLog },
        service, serverNow, lease: view, marksHead: marks.head, query, nextPollMs: pollMs,
      }));
    };
    void handle().catch(() => { if (!response.headersSent) json(response, 503, { error: 'service_unavailable' }); else response.end(); });
  });
};
