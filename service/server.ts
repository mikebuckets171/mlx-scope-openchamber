import http from 'node:http';
import { unavailableTelemetry, type TelemetrySnapshot } from '../src/telemetry.ts';
import type { SystemSnapshot } from '../src/system.ts';
import { runtimeValue, type RuntimeSelection } from '../src/runtime.ts';

type Sources = {
  snapshot: (selection?: RuntimeSelection) => Promise<TelemetrySnapshot>;
  system: () => Promise<SystemSnapshot>;
};
const json = (response: http.ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
};

/** Exact read-only route allowlist. Host and inference failures are independent. */
export const createScopeServer = (token: string, sources: Sources): http.Server => {
  if (!token) throw new Error('A service token is required.');
  return http.createServer((request, response) => {
    const handle = async (): Promise<void> => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.headers.authorization !== `Bearer ${token}`) { json(response, 401, { error: 'unauthorized' }); return; }
      if (request.method !== 'GET') { json(response, 405, { error: 'method_not_allowed' }); return; }
      if (url.pathname === '/health') { json(response, 200, { status: 'healthy' }); return; }
      if (url.pathname === '/snapshot') {
        const provider = url.searchParams.get('provider');
        const requestedRuntime = url.searchParams.get('runtime');
        if (provider !== null && (provider.length > 120 || /[\u0000-\u001f\u007f]/.test(provider)) || requestedRuntime !== null && runtimeValue(requestedRuntime) === null) {
          json(response, 400, { error: 'invalid_connection' }); return;
        }
        const selection = provider || requestedRuntime ? { provider: provider ?? '', runtime: runtimeValue(requestedRuntime) } : undefined;
        const [runtime, system] = await Promise.allSettled([
          Promise.resolve().then(() => sources.snapshot(selection)), Promise.resolve().then(sources.system),
        ]);
        json(response, 200, {
          ...(runtime.status === 'fulfilled' ? runtime.value : unavailableTelemetry('runtime_unreachable', 'Local inference telemetry is unavailable.')),
          system: system.status === 'fulfilled' ? system.value : null,
        });
        return;
      }
      json(response, 404, { error: 'not_found' });
    };
    void handle().catch(() => { if (!response.headersSent) json(response, 503, { error: 'service_unavailable' }); else response.end(); });
  });
};
