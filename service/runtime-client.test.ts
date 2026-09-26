import { expect, test } from 'bun:test';
import { RuntimeClient } from './runtime-client.ts';
import type { RuntimeConnectionConfig, RuntimeConnections } from './config.ts';
import type { Runtime } from '../src/runtime.ts';

const connection = (id: string, runtime: Runtime | null, port = 8000, apiKey: string | null = null): RuntimeConnectionConfig => ({
  id, label: id, runtime, config: { baseURL: new URL(`http://127.0.0.1:${port}/`), apiKey, preferredModel: null,
    issue: apiKey ? 'none' : 'missing_credential', source: 'opencode', configStatus: 'present', authStatus: 'present', error: null },
});
const configuration = (...connections: RuntimeConnectionConfig[]): RuntimeConnections => ({ connections, issue: 'none', error: null });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('parallel views coalesce inventory reads and do no autonomous work', async () => {
  let now = 1000, reads = 0, requests = 0;
  const client = new RuntimeClient({ now: () => now, readConfig: async () => { reads++; return configuration(connection('studio', 'lmstudio')); },
    fetchImpl: async () => { requests++; return json({ models: [] }); } });
  const snapshots = await Promise.all(Array.from({ length: 8 }, () => client.snapshot()));
  expect(snapshots.every(snapshot => snapshot.available && snapshot.connection?.coverage === 'inventory')).toBe(true);
  expect([reads, requests]).toEqual([1, 1]);
  now += 4000; await client.snapshot();
  expect(requests).toBe(1);
  now += 1000; await client.snapshot();
  expect([reads, requests]).toEqual([2, 2]);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(requests).toBe(2);
});

test('rapid selection changes cannot evict active reads and exceed the collection bound', async () => {
  let requests = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const connections = Array.from({ length: 8 }, (_, index) => connection(`local-${index}`, 'lmstudio', 8000 + index));
  const client = new RuntimeClient({ readConfig: async () => configuration(...connections), fetchImpl: async () => {
    requests++; await gate; return json({ models: [] });
  } });
  const pending = connections.map(choice => client.snapshot({ provider: choice.id, runtime: null }));
  await new Promise(resolve => setTimeout(resolve, 0));
  const extra = await client.snapshot({ provider: 'local-0', runtime: 'vllm-mlx' });
  expect(extra.available).toBe(false);
  expect(extra.message).toContain('finishing');
  expect(requests).toBe(8);
  release(); await Promise.all(pending);
  await client.snapshot({ provider: 'local-0', runtime: 'vllm-mlx' });
  expect(requests).toBe(9);
});

test('selected providers keep separate credentials, caches, and backoff', async () => {
  let now = 1000;
  const calls: Array<{ port: string; authorization: string | null }> = [];
  const client = new RuntimeClient({ now: () => now, readConfig: async () => configuration(connection('a', 'lmstudio', 8000, 'fixture-a'), connection('b', 'lmstudio', 8001, 'fixture-b')),
    fetchImpl: async (url, init) => {
      const port = new URL(String(url)).port;
      calls.push({ port, authorization: new Headers(init?.headers).get('authorization') });
      return port === '8000' ? json({}, 401) : json({ models: [] });
    } });
  const failed = await client.snapshot({ provider: 'a', runtime: null });
  expect(failed.connection?.diagnostic).toBe('authentication');
  expect(JSON.stringify(failed)).not.toContain('fixture-a');
  expect((await client.snapshot({ provider: 'b', runtime: null })).available).toBe(true);
  now += 500; await client.snapshot({ provider: 'a', runtime: null });
  expect(calls).toEqual([{ port: '8000', authorization: 'Bearer fixture-a' }, { port: '8001', authorization: 'Bearer fixture-b' }]);
  // Inventory cadence also bounds failed calls; no key-free retry follows rejection.
  now += 5000; await client.snapshot({ provider: 'a', runtime: null });
  expect(calls[2]).toEqual(calls[0]!);
});

test('invalid or removed selected connections do not fall through to another target', async () => {
  let requests = 0;
  const invalid = connection('broken', 'lmstudio'); invalid.config.baseURL = null; invalid.config.issue = 'invalid_endpoint';
  const client = new RuntimeClient({ readConfig: async () => configuration(invalid, connection('working', 'lmstudio')),
    fetchImpl: async () => { requests++; return json({ models: [] }); } });
  expect((await client.snapshot()).connection?.diagnostic).toBe('invalid');
  expect((await client.snapshot({ provider: 'removed', runtime: null })).connection?.diagnostic).toBe('missing');
  expect(requests).toBe(0);
});

test('auto-detects oMLX by anonymous health before any admin authentication', async () => {
  const calls: Array<{ path: string; authorization: string | null; body: string | null }> = [];
  const client = new RuntimeClient({ readConfig: async () => configuration(connection('local', null, 8000, 'fixture-main-key')), fetchImpl: async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, authorization: new Headers(init?.headers).get('authorization'), body: typeof init?.body === 'string' ? init.body : null });
    if (path === '/health') return json({ status: 'healthy', engine_pool: { model_count: 0 } });
    if (path.endsWith('/login')) return new Response('{}', { headers: { 'set-cookie': 'omlx_admin_session=fixture;' } });
    if (path.endsWith('/stats')) return json({ engines: {}, active_models: { models: [] } });
    if (path.endsWith('/activity')) return json({ active_models: { models: [] } });
    return json({ models: [] });
  } });
  const result = await client.snapshot();
  expect(result).toMatchObject({ available: true, runtime: 'omlx', phase: 'notLoaded', connection: { runtime: 'omlx', coverage: 'requests' } });
  expect(calls[0]).toEqual({ path: '/health', authorization: null, body: null });
  expect(calls.findIndex(call => call.path.endsWith('/login'))).toBeGreaterThan(0);
  expect(JSON.stringify(result)).not.toContain('fixture-main-key');
});

test('generic OpenAI model lists do not masquerade as mlx-lm telemetry', async () => {
  const calls: string[] = [];
  const client = new RuntimeClient({ readConfig: async () => configuration(connection('local', null)), fetchImpl: async url => {
    const path = new URL(String(url)).pathname; calls.push(path);
    if (path === '/health') return json({ status: 'ok' });
    if (path === '/api/v1/models') return json({}, 404);
    return json({ object: 'list', data: [{ id: 'model', owned_by: 'mlx' }] });
  } });
  expect((await client.snapshot()).connection?.diagnostic).toBe('unsupported');
  const selected = await client.snapshot({ provider: 'local', runtime: 'mlx-lm' });
  expect(selected).toMatchObject({ available: true, runtime: 'mlx-lm', activeRequests: null, phase: 'unknown' });
  expect(calls).toEqual(['/health', '/api/v1/models', '/v1/models', '/health', '/v1/models']);
});

test('detects a vllm-mlx registry without a loaded engine and exposes limited coverage', async () => {
  const client = new RuntimeClient({ readConfig: async () => configuration(connection('local', null)), fetchImpl: async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/health') return json({ model_loaded: true, engine_type: 'unknown', available_models: ['fixture'] });
    if (path === '/v1/status') return json({ status: 'running', model_manager: { models: [{ id: 'fixture', loaded: false }] } });
    throw new Error('Unexpected endpoint');
  } });
  expect(await client.snapshot()).toMatchObject({ available: true, runtime: 'vllm-mlx', phase: 'unknown', activeRequests: null,
    connection: { diagnostic: 'ready', coverage: 'server' }, catalog: [{ name: 'fixture', loaded: false }] });
});

test('Splash uses one authenticated status read, server coverage, and the 2 second cadence', async () => {
  let now = 1000;
  const calls: Array<{ path: string; authorization: string | null }> = [];
  const client = new RuntimeClient({ now: () => now,
    readConfig: async () => configuration(connection('splash', 'splash', 8000, 'splash-fixture-key')),
    fetchImpl: async (url, init) => {
      calls.push({ path: new URL(String(url)).pathname, authorization: new Headers(init?.headers).get('authorization') });
      return json({ ready: true, instance: { model: 'incoai/Qwen3.8-27B-Splash' },
        requests: { completed: 17, failed: 0 }, metrics: { decode_tokens_per_second: 47.2 } });
    },
  });

  const first = await client.snapshot();
  expect(first).toMatchObject({ available: true, runtime: 'splash', liveDecodeTPS: null,
    connection: { runtime: 'splash', coverage: 'server', diagnostic: 'ready' } });
  now += 1999; await client.snapshot();
  expect(calls).toHaveLength(1);
  now += 1; await client.snapshot();
  expect(calls).toEqual([
    { path: '/status', authorization: 'Bearer splash-fixture-key' },
    { path: '/status', authorization: 'Bearer splash-fixture-key' },
  ]);
  expect(JSON.stringify(first)).not.toContain('splash-fixture-key');
});

test('redirects stop discovery before credentials or fallback requests', async () => {
  let requests = 0;
  const client = new RuntimeClient({ readConfig: async () => configuration(connection('local', null, 8000, 'fixture-key')), fetchImpl: async (_url, init) => {
    requests++; expect(init?.redirect).toBe('manual'); expect(new Headers(init?.headers).has('authorization')).toBe(false);
    return new Response('', { status: 302, headers: { location: 'http://127.0.0.1:9000' } });
  } });
  expect((await client.snapshot()).available).toBe(false);
  expect(requests).toBe(1);
});

test('configuration changes invalidate an adapter and its credential immediately after refresh', async () => {
  let now = 1000, key = 'first-fixture';
  const sent: Array<string | null> = [];
  const client = new RuntimeClient({ now: () => now, readConfig: async () => configuration(connection('local', 'lmstudio', 8000, key)), fetchImpl: async (_url, init) => {
    sent.push(new Headers(init?.headers).get('authorization')); return json({ models: [] });
  } });
  const first = await client.snapshot();
  expect((await client.snapshot()).connection?.generation).toBe(first.connection?.generation);
  key = 'replacement-fixture'; now += 5000;
  const second = await client.snapshot();
  expect(second.connection?.generation).not.toBe(first.connection?.generation);
  expect(sent).toEqual(['Bearer first-fixture', 'Bearer replacement-fixture']);
});

test('endpoint replacement and service recreation change the connection marker without exposing the endpoint', async () => {
  let now = 1000, port = 8000;
  const options = { now: () => now,
    readConfig: async () => configuration(connection('local', 'lmstudio', port)),
    fetchImpl: async () => json({ models: [] }) };
  const client = new RuntimeClient(options);
  const first = await client.snapshot();
  port = 8001; now += 5000;
  const second = await client.snapshot();
  const restarted = await new RuntimeClient(options).snapshot();
  const markers = [first, second, restarted].map(snapshot => snapshot.connection?.generation);
  expect(markers.every(marker => typeof marker === 'string' && marker.length === 36)).toBe(true);
  expect(new Set(markers).size).toBe(3);
  expect(second.connection?.selected).toBe(first.connection?.selected);
  expect(second.connection?.runtime).toBe(first.connection?.runtime);
  expect(JSON.stringify(second)).not.toContain('127.0.0.1');
});

test('discovery and oMLX authentication share one real collection deadline', async () => {
  let requests = 0;
  const signals: AbortSignal[] = [];
  const client = new RuntimeClient({ collectionDeadlineMs: 140, requestTimeoutMs: 140,
    readConfig: async () => configuration(connection('local', null, 8000, 'fixture-key')),
    fetchImpl: async (_url, init) => {
      requests++; if (init?.signal) signals.push(init.signal);
      if (requests === 1) { await new Promise(resolve => setTimeout(resolve, 85)); return json({ status: 'healthy', engine_pool: { model_count: 1 } }); }
      return new Promise<Response>(() => {});
    } });
  const start = performance.now();
  expect((await client.snapshot()).available).toBe(false);
  expect(performance.now() - start).toBeLessThan(220);
  expect(requests).toBe(2);
  expect(signals.every(signal => signal.aborted)).toBe(true);
});
