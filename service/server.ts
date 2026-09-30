import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { version as packageVersion } from '../package.json';
import type { AlertLogEntryV2, AlertV2 } from '../src/contract/alerts.ts';
import { hostFromV1 } from '../src/contract/convert-v1.ts';
import { assertBodyLimit } from '../src/contract/guards.ts';
import type { HostV2 } from '../src/contract/host.ts';
import { isBadQuery, parseSnapshotQuery, parseTrendQuery, parseUsageQuery, type TrendQuery, type UsageQuery } from '../src/contract/query.ts';
import type { TrendV2 } from '../src/contract/trend.ts';
import type { UsageV2 } from '../src/contract/usage.ts';
import type { SystemSnapshot } from '../src/system.ts';
import { healthBody, NOT_FOUND_BODY, RETIRED_BODY, RETIRED_STATUS, ROUTES } from '../src/contract/version.ts';
import { composeSnapshot } from './core/compose.ts';
import { Lease } from './core/lease.ts';
import { Marks } from './core/marks.ts';
import { Verdicts } from './core/verdicts.ts';
import type { HostContext } from './host/sampler.ts';
import { busy, type ReadRequest, type ReadSelection, type RuntimeReading } from './runtime-client.ts';

export type Sources = {
  read: (selection?: ReadSelection, request?: ReadRequest) => Promise<RuntimeReading>;
  /** Host readings for this request's tier (svc-host's HostSampler.sample). */
  host?: (context: HostContext) => Promise<HostV2 | null>;
  /** The 1.x sampler, kept so 2a-era callers still work; used only without `host`. */
  system?: () => Promise<SystemSnapshot>;
  /** The newest completion seq assigned; verdicts for later seqs are dropped. */
  completionHead?: () => number;
  /** Active alerts and the alert log for this reading (svc-history's AlertBook); absent → none. */
  alerts?: (input: { reading: RuntimeReading; host: HostV2 | null; leader: boolean; now: number }) => { alerts: AlertV2[]; alertLog: AlertLogEntryV2[] };
  /** `/v2/trend` and `/v2/usage` bodies (svc-history); absent → 501 until they are served. */
  trend?: (query: TrendQuery) => Promise<TrendV2>;
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
const NO_ALERTS = { alerts: [], alertLog: [] };

/** A reading the collector could not produce at all: nothing about the runtime is known, so nothing is claimed. */
const unread = (at: number): RuntimeReading => ({
  at, status: { state: 'failing', reason: 'runtime_unreachable', params: {} }, capabilities: {}, identity: {}, completions: [],
  runtime: { phase: 'unknown', request: null, server: { active: null, queued: null }, memory: {}, residency: [], slots: [], catalog: [], engines: [] },
  meta: { connection: { id: 'auto', label: 'Automatic', runtime: null, generation: 0, choices: [], detection: { basis: 'probe', confidence: 'low' } },
    port: null, slot: null, failures: 0, idleMs: 0, completions: null,
    compat: { message: null, connection: { selected: null, generation: null, diagnostic: 'offline', coverage: null }, modelID: null, contextWindow: null,
      statsState: 'unavailable', guardLevel: null, lastMissReason: null, traceEpoch: null } },
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
          else if (sources.trend) json(response, 200, await sources.trend(query)); else json(response, 501, NOT_IMPLEMENTED);
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
      verdicts.record(query.attrs, serverNow, sources.completionHead?.() ?? 0);
      const view = lease.observe(query.frame, query.surface, monotonic());
      // 1.6 semantics: provider '' with a runtime is "Automatic, read as that runtime".
      const selection = query.provider || query.runtime ? { provider: query.provider ?? '', runtime: query.runtime ?? null } : undefined;
      const reading = await Promise.resolve().then(() => sources.read(selection, { tier: query.tier, detail: query.detail === 'server' }))
        .catch(() => unread(serverNow));
      const { connection } = reading.meta;
      const context: HostContext = { tier: query.tier, active: busy(reading.runtime), generation: connection.generation,
        omlxPort: connection.runtime === 'omlx' ? reading.meta.port : null };
      const host = await Promise.resolve().then(async () => sources.host ? sources.host(context) : sources.system ? hostFromV1(await sources.system()) : null)
        .catch(() => null);
      const completions = reading.meta.completions?.since(query.since, seq => verdicts.get(seq))
        ?? { instance: service.instance, cursor: 0, reset: query.since !== undefined && query.since > 0, items: [] };
      json(response, 200, composeSnapshot({
        reading, host, completions, alerts: sources.alerts?.({ reading, host, leader: view.leader, now: serverNow }) ?? NO_ALERTS,
        service, serverNow, lease: view, marksHead: marks.head, query,
      }));
    };
    void handle().catch(() => { if (!response.headersSent) json(response, 503, { error: 'service_unavailable' }); else response.end(); });
  });
};
