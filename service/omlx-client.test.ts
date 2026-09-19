import { describe, expect, it } from 'bun:test';
import { OmlxClient, __test__ } from './omlx-client.ts';
import { resolveOmlxConfig, type OmlxConfig } from './config.ts';

const response = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  ...init,
});

const config: OmlxConfig = {
  baseURL: new URL('http://127.0.0.1:8123/'),
  apiKey: 'private-key',
  preferredModel: null,
  error: null,
  issue: 'none',
  source: 'environment',
  configStatus: 'missing',
  authStatus: 'missing',
};

describe('MLX Scope service client', () => {
  it('extracts only the oMLX session cookie', () => {
    expect(__test__.extractCookie('other=x; Path=/, omlx_admin_session=abc123; HttpOnly')).toBe('abc123');
    expect(__test__.extractCookie(null)).toBeNull();
  });

  it('performs health, optional model status, login, stats, and activity reads', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          for (const [k, v] of (init.headers as unknown as { entries(): IterableIterator<[string, string]> }).entries()) headers[k] = v;
        } else if (Array.isArray(init.headers)) {
          for (const [k, v] of init.headers as Array<[string, string]>) headers[k] = v;
        } else {
          Object.assign(headers, init.headers as Record<string, string>);
        }
      }
      calls.push({ url: String(url), init: { ...init, headers } as RequestInit });
      if (String(url).endsWith('/health')) return response({ status: 'healthy', engine_pool: { model_count: 1 } });
      if (String(url).endsWith('/v1/models/status')) return response({ models: [{ id: 'qwen', max_context_window: 8192 }] });
      if (String(url).endsWith('/admin/api/login')) return response({ ok: true }, { headers: { 'set-cookie': 'omlx_admin_session=test-cookie; Path=/' } });
      if (String(url).includes('/admin/api/stats')) return response({
        engines: { mlx: 1 },
        total_requests: 1,
        active_models: { models: [{ id: 'qwen', active_requests: 0, waiting_requests: 0, prefilling: [], generating: [], waiting: [], activities: [] }] },
      });
      if (String(url).endsWith('/admin/api/activity')) return response({
        active_models: { models: [{ id: 'qwen', active_requests: 0, waiting_requests: 0, prefilling: [], generating: [], waiting: [], activities: [] }] },
      });
      return response({ error: 'not found' }, { status: 404 });
    };
    const client = new OmlxClient({ fetchImpl, readConfig: async () => config, now: () => 100_000 });
    const result = await client.snapshot();
    expect(result).toMatchObject({ available: true, modelID: 'qwen', contextWindow: 8192 });
    expect(calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:8123/health',
      'http://127.0.0.1:8123/admin/api/login',
      'http://127.0.0.1:8123/admin/api/activity',
      'http://127.0.0.1:8123/v1/models/status',
      'http://127.0.0.1:8123/admin/api/stats?scope=session',
    ]);
    const headersOf = (suffix: string): Record<string, string> | undefined => {
      const found = calls.find((call) => call.url.endsWith(suffix));
      return found ? (found.init.headers as Record<string, string>) : undefined;
    };
    expect(headersOf('/admin/api/login')?.['Content-Type']).toBe('application/json');
    expect(headersOf('/stats?scope=session')?.Cookie).toBe('omlx_admin_session=test-cookie');
    expect(headersOf('/v1/models/status')?.['Content-Type']).toBeUndefined();
  });

  it('coalesces panels, caches config and returns a valid no-model snapshot', async () => {
    let reads = 0;
    let activities = 0;
    let now = 100_000;
    const fetchImpl = async (url: RequestInfo | URL): Promise<Response> => {
      if (String(url).endsWith('/health')) return response({ status: 'healthy', engine_pool: { model_count: 0 } });
      if (String(url).endsWith('/admin/api/login')) return response({}, { headers: { 'set-cookie': 'omlx_admin_session=fixture;' } });
      if (String(url).includes('/stats')) return response({ engines: {}, total_requests: 0, active_models: { models: [] } });
      if (String(url).endsWith('/activity')) { activities += 1; return response({ active_models: { models: [] } }); }
      return response({ models: [] });
    };
    const client = new OmlxClient({ now: () => now, readConfig: async () => { reads += 1; return config; }, fetchImpl });
    const first = client.snapshot();
    expect(client.snapshot()).toBe(first);
    expect(await first).toMatchObject({ available: true, phase: 'notLoaded' });
    await client.snapshot();
    expect(activities).toBe(1);
    now += 500;
    await client.snapshot();
    expect(activities).toBe(2);
    expect(reads).toBe(1);
    now += 5_000;
    await client.snapshot();
    expect(reads).toBe(2);
  });

  it('observes prefill staleness and opaque request continuity without leaking IDs', async () => {
    let now = 100_000;
    let requestID = 'private-original';
    let total = 100;
    let phase = 'prefill';
    const active = () => ({ models: [{ id: 'fixture', active_requests: 1, prefilling: [{ request_id: requestID, processed: 5, total, phase, speed: 50 }] }] });
    const client = new OmlxClient({ now: () => now, readConfig: async () => config, fetchImpl: async (url) => {
      if (String(url).endsWith('/health')) return response({ status: 'healthy', engine_pool: { model_count: 1 } });
      if (String(url).endsWith('/login')) return response({}, { headers: { 'set-cookie': 'omlx_admin_session=fixture;' } });
      if (String(url).includes('/stats')) return response({ engines: {}, total_requests: 1, active_models: active() });
      if (String(url).endsWith('/activity')) return response({ active_models: active() });
      return response({ models: [] });
    } });
    const first = await client.snapshot();
    expect(first.livePrefillTPS).toBe(50);
    now += 16_000;
    const stale = await client.snapshot();
    expect(stale.livePrefillTPS).toBeNull();
    expect(stale.prefillProgressStale).toBe(true);
    total = 200; phase = 'next-stage'; now += 500;
    const stage = await client.snapshot();
    expect(stage.prefillProgressStale).toBe(false);
    expect(stage.traceEpoch).not.toBe(stale.traceEpoch);
    expect(stage.prefillProgress).toBe(0.025);
    requestID = 'private-next';
    now += 500;
    const next = await client.snapshot();
    expect(next.traceEpoch).not.toBe(first.traceEpoch);
    expect(next.livePrefillTPS).toBe(50);
    expect(JSON.stringify(next)).not.toContain('private-');
  });

  it('rejects redirects before sending credentials anywhere else', async () => {
    const calls: string[] = [];
    const client = new OmlxClient({ readConfig: async () => config, fetchImpl: async (url, init) => {
      calls.push(String(url));
      expect(init?.redirect).toBe('manual');
      return new Response('', { status: 302, headers: { Location: 'https://example.com' } });
    } });
    expect((await client.snapshot()).available).toBe(false);
    expect(calls).toEqual(['http://127.0.0.1:8123/health']);
  });

  it('keeps live activity when session statistics are unavailable', async () => {
    let statsCalls = 0;
    const fetchImpl = async (url: RequestInfo | URL): Promise<Response> => {
      if (String(url).endsWith('/health')) return response({ status: 'healthy', engine_pool: { model_count: 1 } });
      if (String(url).endsWith('/admin/api/login')) return response({}, { headers: { 'set-cookie': 'omlx_admin_session=fixture;' } });
      if (String(url).includes('/stats')) {
        statsCalls += 1;
        return response({ error: 'temporary' }, { status: 503 });
      }
      if (String(url).endsWith('/activity')) return response({
        active_models: { models: [{ id: 'qwen', active_requests: 1, prefilling: [], generating: [{ request_id: 'private', generated_tokens: 24, elapsed_seconds: 1.5, tokens_per_second: 16, last_activity_age_seconds: 0, prompt_tokens: 512 }], waiting: [], activities: [] }] },
      });
      return response({ models: [] });
    };
    const client = new OmlxClient({ fetchImpl, readConfig: async () => config, now: () => 100_000 });
    const first = await client.snapshot();
    expect(first).toMatchObject({ available: true, modelID: 'qwen', liveDecodeTPS: 16, sessionStatsState: 'unavailable' });
    expect(statsCalls).toBe(1);
  });

  it('expires the snapshot by a single deadline rather than each endpoint', async () => {
    let mono = 0;
    const fetchImpl = async (url: RequestInfo | URL): Promise<Response> => {
      if (String(url).endsWith('/health')) return response({ status: 'healthy', engine_pool: { model_count: 1 } });
      if (String(url).endsWith('/admin/api/login')) return response({}, { headers: { 'set-cookie': 'omlx_admin_session=fixture;' } });
      if (String(url).includes('/stats')) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return response({ engines: {}, active_models: { models: [] } });
      }
      if (String(url).endsWith('/activity')) return response({ active_models: { models: [] } });
      if (String(url).endsWith('/v1/models/status')) return response({ models: [] });
      return response({});
    };
    const client = new OmlxClient({
      fetchImpl,
      readConfig: async () => config,
      now: () => 100_000,
      monotonicNow: () => (mono += 1_000),
      collectionDeadlineMs: 1_500,
    });
    const result = await client.snapshot();
    expect(result).toMatchObject({ available: false, reason: 'runtime_unreachable' });
    expect((result as { message: string | null }).message).toMatch(/deadline/);
  });

  it('honours an absolute OPENCODE_CONFIG override and refuses non-absolute values', async () => {
    const absolute = '/tmp/mlx-scope-override-config.json';
    const files = new Map<string, string>([
      [absolute, JSON.stringify({ provider: { omlx: { options: { baseURL: 'http://127.0.0.1:8123/v1' } } } })],
    ]);
    expect((await resolveOmlxConfig({
      env: { OPENCODE_CONFIG: absolute },
      home: '/tmp/mlx-scope-override-home',
      readText: async (path) => files.get(path) ?? null,
    })).baseURL?.toString()).toBe('http://127.0.0.1:8123/');
    expect((await resolveOmlxConfig({
      env: { OPENCODE_CONFIG: 'relative.json' },
      home: '/tmp/mlx-scope-override-home',
      readText: async () => null,
    })).issue).toBe('unsupported_config');
  });
});


it('shares a bounded failure backoff independently of host resource polling', async () => {
  let clock = 100_000, calls = 0;
  const client = new OmlxClient({ now: () => clock, monotonicNow: () => clock,
    readConfig: async () => config, fetchImpl: async () => { calls++; throw Error('offline'); } });
  await client.snapshot(); expect(calls).toBe(1);
  clock += 500; await client.snapshot(); expect(calls).toBe(1);
  clock += 500; await client.snapshot(); expect(calls).toBe(2);
  clock += 1000; await client.snapshot(); expect(calls).toBe(2);
  clock += 1000; await client.snapshot(); expect(calls).toBe(3);
});
