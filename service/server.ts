import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { version as packageVersion } from '../package.json';
import { assertBodyLimit } from '../src/contract/guards.ts';
import { isBadQuery, parseSnapshotQuery, parseTrendQuery, parseUsageQuery, type TrendQuery, type UsageQuery } from '../src/contract/query.ts';
import type { TrendV2 } from '../src/contract/trend.ts';
import type { UsageV2 } from '../src/contract/usage.ts';
import { NOT_FOUND_BODY, RETIRED_BODY, RETIRED_STATUS, ROUTES } from '../src/contract/version.ts';
import { runtimeValue, type RuntimeSelection } from '../src/runtime.ts';
import type { SystemSnapshot } from '../src/system.ts';
import { unavailableTelemetry } from '../src/telemetry.ts';
import { composeSnapshot } from './core/compose.ts';
import { Lease } from './core/lease.ts';
import { Marks } from './core/marks.ts';
import { Verdicts } from './core/verdicts.ts';
import type { RuntimeReading } from './runtime-client.ts';

export type Sources = {
  read: (selection?: RuntimeSelection) => Promise<RuntimeReading>;
  system: () => Promise<SystemSnapshot>;
  /** The newest completion seq assigned; verdicts for later seqs are dropped. */
  completionHead?: () => number;
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
const FALLBACK: RuntimeReading['meta'] = { generation: 0, detection: { basis: 'probe', confidence: 'low' }, failures: 0, idleMs: 0, completionSeq: null };
const UNSERVED = (at: number): RuntimeReading => ({ snapshot: unavailableTelemetry('unsupported_contract', null, at),
  meta: { ...FALLBACK, detection: { basis: 'explicit', confidence: 'high' } } });

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
      if (url.pathname === ROUTES.health) { json(response, 200, { status: 'healthy' }); return; }
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
      // Every runtime kind is a valid selection. The 2a reader serves the 1.6 runtimes; until llama-server and Ollama
      // are wired to their v2 adapters, their reading says so (unsupported contract) instead of a 400.
      const runtime = query.runtime === undefined ? null : runtimeValue(query.runtime);
      const unserved = query.runtime !== undefined && runtime === null;
      const serverNow = now();
      marks.record(query.marks, serverNow);
      verdicts.record(query.attrs, serverNow, sources.completionHead?.() ?? 0);
      const view = lease.observe(query.frame, query.surface, monotonic());
      const selection = query.provider || runtime ? { provider: query.provider ?? '', runtime } : undefined;
      const [reading, system] = await Promise.allSettled([
        Promise.resolve().then(() => unserved ? UNSERVED(serverNow) : sources.read(selection)), Promise.resolve().then(sources.system),
      ]);
      json(response, 200, composeSnapshot({
        reading: reading.status === 'fulfilled' ? reading.value
          : { snapshot: unavailableTelemetry('runtime_unreachable', 'Local inference telemetry is unavailable.', serverNow), meta: FALLBACK },
        system: system.status === 'fulfilled' ? system.value : null, service, serverNow, lease: view, marksHead: marks.head,
        verdict: seq => verdicts.get(seq), query,
      }));
    };
    void handle().catch(() => { if (!response.headersSent) json(response, 503, { error: 'service_unavailable' }); else response.end(); });
  });
};
