import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { version as packageVersion } from '../package.json';
import { assertBodyLimit } from '../src/contract/guards.ts';
import { isBadQuery, parseSnapshotQuery, parseTrendQuery, parseUsageQuery } from '../src/contract/query.ts';
import { badQuery, NOT_FOUND_BODY, RETIRED_BODY, RETIRED_STATUS, ROUTES } from '../src/contract/version.ts';
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
        const query = url.pathname === ROUTES.trend ? parseTrendQuery(url.searchParams) : parseUsageQuery(url.searchParams);
        if (isBadQuery(query)) json(response, 400, query); else json(response, 501, NOT_IMPLEMENTED);
        return;
      }
      if (url.pathname !== ROUTES.snapshot) { json(response, 404, NOT_FOUND_BODY); return; }
      const query = parseSnapshotQuery(url.searchParams);
      if (isBadQuery(query)) { json(response, 400, query); return; }
      // 2a serves the 1.6 runtimes; llama-server and Ollama arrive with their adapters.
      const runtime = query.runtime === undefined ? null : runtimeValue(query.runtime);
      if (query.runtime !== undefined && runtime === null) { json(response, 400, badQuery('runtime')); return; }
      const serverNow = now();
      marks.record(query.marks, serverNow);
      verdicts.record(query.attrs, serverNow, sources.completionHead?.() ?? 0);
      const view = lease.observe(query.frame, query.surface, monotonic());
      const selection = query.provider || runtime ? { provider: query.provider ?? '', runtime } : undefined;
      const [reading, system] = await Promise.allSettled([
        Promise.resolve().then(() => sources.read(selection)), Promise.resolve().then(sources.system),
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
