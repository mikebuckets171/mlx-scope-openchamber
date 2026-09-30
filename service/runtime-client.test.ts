import { expect, test } from 'bun:test';
import type { RuntimeKind } from '../src/contract/runtime.ts';
import type { RuntimeConnectionConfig, RuntimeConnections } from './config.ts';
import type { AdapterReadingV2, DescriptorV2 } from './core/adapter-v2.ts';
import { RuntimeClient, type ReadSelection, type RuntimeReading } from './runtime-client.ts';

const connection = (id: string, runtime: RuntimeKind | null, port = 8000, apiKey: string | null = null, label = id): RuntimeConnectionConfig => ({
  id, label, runtime: runtime as RuntimeConnectionConfig['runtime'], config: { baseURL: new URL(`http://127.0.0.1:${port}/`), apiKey, preferredModel: null,
    issue: apiKey ? 'none' : 'missing_credential', source: 'opencode', configStatus: 'present', authStatus: 'present', error: null },
});
const configuration = (...connections: RuntimeConnectionConfig[]): RuntimeConnections => ({ connections, issue: 'none', error: null });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const path = (url: unknown) => new URL(String(url)).pathname;
const english = (reading: RuntimeReading) => [reading.meta.compat.message, JSON.stringify(reading.status)];

test('parallel views coalesce inventory reads and do no autonomous work', async () => {
  let now = 1000, reads = 0, requests = 0;
  const client = new RuntimeClient({ now: () => now, readConfig: async () => { reads++; return configuration(connection('studio', 'lmstudio')); },
    fetchImpl: async () => { requests++; return json({ models: [] }); } });
  const readings = await Promise.all(Array.from({ length: 8 }, () => client.read()));
  expect(readings.every(reading => reading.status.state === 'ready' && reading.meta.compat.connection?.coverage === 'inventory')).toBe(true);
  expect([reads, requests]).toEqual([1, 1]);
  now += 4000; await client.read();
  expect(requests).toBe(1);
  now += 1000; await client.read();
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
  const pending = connections.map(choice => client.read({ provider: choice.id, runtime: null }));
  await new Promise(resolve => setTimeout(resolve, 0));
  const extra = await client.read({ provider: 'local-0', runtime: 'vllm-mlx' });
  expect(extra.status).toEqual({ state: 'failing', reason: 'runtime_unreachable', params: { port: 8000, deferred: true } });
  expect(requests).toBe(8);
  release(); await Promise.all(pending);
  await client.read({ provider: 'local-0', runtime: 'vllm-mlx' });
  expect(requests).toBe(9);
});

test('selected providers keep separate credentials, caches, and backoff; the key never enters a reading', async () => {
  let now = 1000;
  const calls: Array<{ port: string; authorization: string | null }> = [];
  const client = new RuntimeClient({ now: () => now, readConfig: async () => configuration(connection('a', 'lmstudio', 8000, 'fixture-a'), connection('b', 'lmstudio', 8001, 'fixture-b')),
    fetchImpl: async (url, init) => {
      const port = new URL(String(url)).port;
      calls.push({ port, authorization: new Headers(init?.headers).get('authorization') });
      return port === '8000' ? json({}, 401) : json({ models: [] });
    } });
  const failed = await client.read({ provider: 'a', runtime: null });
  expect(failed.status).toEqual({ state: 'failing', reason: 'authentication_failed', params: { port: 8000, keySaved: true } });
  expect(failed.meta.compat.connection?.diagnostic).toBe('authentication');
  expect(JSON.stringify(failed)).not.toContain('fixture-a');
  expect((await client.read({ provider: 'b', runtime: null })).status.state).toBe('ready');
  now += 500; await client.read({ provider: 'a', runtime: null });
  expect(calls).toEqual([{ port: '8000', authorization: 'Bearer fixture-a' }, { port: '8001', authorization: 'Bearer fixture-b' }]);
  // Inventory cadence also bounds failed calls; no key-free retry follows rejection.
  now += 5000; await client.read({ provider: 'a', runtime: null });
  expect(calls[2]).toEqual(calls[0]!);
});

test('configuration problems are codes with the 1.6 issue, and never fall through to another connection', async () => {
  let requests = 0;
  const invalid = connection('broken', 'lmstudio'); invalid.config.baseURL = null; invalid.config.issue = 'invalid_endpoint';
  const client = new RuntimeClient({ readConfig: async () => configuration(invalid, connection('working', 'lmstudio')),
    fetchImpl: async () => { requests++; return json({ models: [] }); } });
  const broken = await client.read();
  expect([broken.status, broken.meta.compat.connection?.diagnostic]).toEqual([{ state: 'unconfigured', reason: 'configuration_missing', params: { issue: 'invalid_endpoint' } }, 'invalid']);
  const removed = await client.read({ provider: 'removed', runtime: null });
  expect([removed.status.params, removed.meta.compat.connection?.diagnostic, removed.meta.connection.id]).toEqual([{ issue: 'removed' }, 'missing', 'auto']);
  expect(requests).toBe(0);
  const empty = new RuntimeClient({ readConfig: async () => ({ connections: [], issue: 'malformed_config', error: 'x' }) });
  expect((await empty.read()).status.params).toEqual({ issue: 'malformed_config' });
  const unreadable = new RuntimeClient({ readConfig: async () => { throw new Error('EACCES /private/path'); } });
  const failed = await unreadable.read();
  expect([failed.status.params, failed.meta.compat.connection?.diagnostic]).toEqual([{ issue: 'read_failed' }, 'unreadable']);
  expect(JSON.stringify(failed)).not.toContain('/private');
  for (const reading of [broken, removed, failed]) expect(english(reading)[0]).toBeNull();
});

test('auto-detects oMLX by anonymous health before any admin authentication', async () => {
  const calls: Array<{ path: string; authorization: string | null; body: string | null }> = [];
  const client = new RuntimeClient({ readConfig: async () => configuration(connection('local', null, 8000, 'fixture-main-key')), fetchImpl: async (url, init) => {
    calls.push({ path: path(url), authorization: new Headers(init?.headers).get('authorization'), body: typeof init?.body === 'string' ? init.body : null });
    if (path(url) === '/health') return json({ status: 'healthy', engine_pool: { model_count: 0 } });
    if (path(url).endsWith('/login')) return new Response('{}', { headers: { 'set-cookie': 'omlx_admin_session=fixture;' } });
    if (path(url).endsWith('/stats')) return json({ engines: {}, active_models: { models: [] } });
    if (path(url).endsWith('/activity')) return json({ active_models: { models: [] } });
    return json({ models: [] });
  } });
  const result = await client.read();
  expect(result).toMatchObject({ status: { state: 'ready' }, runtime: { phase: 'not-loaded' },
    meta: { connection: { runtime: 'omlx', detection: { basis: 'probe', confidence: 'high', probe: '/health' } }, compat: { connection: { coverage: 'requests' } } } });
  expect(calls[0]).toEqual({ path: '/health', authorization: null, body: null });
  expect(calls.findIndex(call => call.path.endsWith('/login'))).toBeGreaterThan(0);
  expect(JSON.stringify(result)).not.toContain('fixture-main-key');
});

test('generic OpenAI model lists do not masquerade as a runtime; an explicit mlx-lm is read as one', async () => {
  const calls: string[] = [];
  const client = new RuntimeClient({ readConfig: async () => configuration(connection('local', null)), fetchImpl: async url => {
    calls.push(path(url));
    if (path(url) === '/health') return json({ status: 'ok' });
    if (path(url) === '/lmstudio-greeting' || path(url) === '/api/v1/models' || path(url) === '/status') return json({}, 404);
    return json({ object: 'list', data: [{ id: 'model', owned_by: 'mlx' }] });
  } });
  const unknown = await client.read();
  expect([unknown.status, unknown.meta.compat.connection?.diagnostic]).toEqual([{ state: 'unconfigured', reason: 'unsupported_runtime', params: { port: 8000 } }, 'unsupported']);
  const selected = await client.read({ provider: 'local', runtime: 'mlx-lm' });
  expect(selected).toMatchObject({ status: { state: 'ready' }, runtime: { phase: 'unknown', request: null, server: { active: null } },
    meta: { connection: { runtime: 'mlx-lm', detection: { basis: 'explicit', confidence: 'high' } } } });
  expect(calls).toEqual(['/health', '/props', '/api/version', '/lmstudio-greeting', '/api/v1/models', '/status', '/v1/models', '/health', '/v1/models']);
});

test('auto-detects a standalone Splash server by its status contract', async () => {
  const calls: string[] = [];
  const client = new RuntimeClient({ readConfig: async () => configuration(connection('local', null)), fetchImpl: async url => {
    calls.push(path(url));
    if (path(url) === '/health') return json({ status: 'ok' });
    if (path(url) === '/status') return json({ ready: false, instance: { model: 'incoai/Qwen3.8-27B-Splash', pid: 4242 } });
    return json({}, 404);
  } });
  const result = await client.read();
  expect(calls.slice(0, 6)).toEqual(['/health', '/props', '/api/version', '/lmstudio-greeting', '/api/v1/models', '/status']);
  // A loading Splash server answered, so it is reachable rather than offline; the English is the panel's, from the code.
  expect(result).toMatchObject({ status: { state: 'degraded', reason: 'loading', params: {} },
    meta: { connection: { runtime: 'splash', engine: 'splash', host: null, detection: { probe: '/status' } }, compat: { message: null, connection: { diagnostic: 'ready' } } } });
  expect(JSON.stringify(result)).not.toMatch(/4242|Loading/);
});

test('Splash-format models behind an LM Studio-compatible API are Splash via Bionic', async () => {
  const models = { models: [
    { key: 'local/qwen3.8-27b-splash-levels', type: 'llm', format: 'splash', max_context_length: 262_144,
      loaded_instances: [{ id: 'local/qwen3.8-27b-splash-levels', config: { context_length: 262_144 } }] },
    { key: 'qwen3.6-35b-a3b-splash', type: 'llm', format: 'splash', max_context_length: 262_144, loaded_instances: [] },
    { key: 'text-embedding-nomic-embed-text-v1.5', type: 'embedding', format: 'gguf', max_context_length: 2048, loaded_instances: [] },
  ] };
  const client = new RuntimeClient({ readConfig: async () => configuration(connection('lmstudio', null, 1234)), fetchImpl: async url =>
    path(url) === '/lmstudio-greeting' ? json({ lmstudio: true }) : path(url) === '/api/v1/models' ? json(models) : json({ error: 'Unexpected endpoint or method.' }) });
  const result = await client.read();
  expect(result).toMatchObject({ status: { state: 'ready' }, meta: { connection: { runtime: 'lmstudio', engine: 'splash', host: 'bionic',
    detection: { basis: 'probe', confidence: 'high', probe: '/lmstudio-greeting' } }, compat: { modelID: 'local/qwen3.8-27b-splash-levels' } } });
  expect(result.runtime.catalog.map(model => model.format)).toEqual(['splash', 'splash', 'gguf']);
  const plain = new RuntimeClient({ readConfig: async () => configuration(connection('studio', 'lmstudio', 1234)), fetchImpl: async () => json({ models: [models.models[2]] }) });
  expect((await plain.read()).meta.connection).toMatchObject({ engine: null, host: null });
  const named = new RuntimeClient({ readConfig: async () => configuration(connection('local', 'lmstudio', 1234, null, 'Bionic')), fetchImpl: async () => json({ models: [] }) });
  expect((await named.read()).meta.connection.host).toBe('bionic');
});

test('a vllm-mlx registry without a loaded engine exposes limited coverage', async () => {
  const client = new RuntimeClient({ readConfig: async () => configuration(connection('local', null)), fetchImpl: async url => {
    if (path(url) === '/health') return json({ model_loaded: true, engine_type: 'unknown', available_models: ['fixture'] });
    if (path(url) === '/v1/status') return json({ status: 'running', model_manager: { models: [{ id: 'fixture', loaded: false }] } });
    throw new Error('Unexpected endpoint');
  } });
  expect(await client.read()).toMatchObject({ status: { state: 'ready' }, runtime: { phase: 'unknown', server: { active: null }, catalog: [{ name: 'fixture', loaded: false }] },
    meta: { connection: { runtime: 'vllm-mlx' }, compat: { connection: { diagnostic: 'ready', coverage: 'server' } } } });
});

test('Splash uses one authenticated status read, server coverage, and the 2 second cadence', async () => {
  let now = 1000;
  const calls: Array<{ path: string; authorization: string | null }> = [];
  const client = new RuntimeClient({ now: () => now, readConfig: async () => configuration(connection('splash', 'splash', 8000, 'splash-fixture-key')),
    fetchImpl: async (url, init) => {
      calls.push({ path: path(url), authorization: new Headers(init?.headers).get('authorization') });
      return json({ ready: true, instance: { model: 'incoai/Qwen3.8-27B-Splash' }, requests: { completed: 17, failed: 0 }, metrics: { decode_tokens_per_second: 47.2 } });
    } });
  const first = await client.read();
  expect(first).toMatchObject({ status: { state: 'ready' }, meta: { connection: { runtime: 'splash', detection: { basis: 'hint' } }, compat: { connection: { coverage: 'server' } } } });
  expect(first.runtime.request).toBeNull();
  now += 1999; await client.read();
  expect(calls).toHaveLength(1);
  now += 1; await client.read();
  expect(calls).toEqual([{ path: '/status', authorization: 'Bearer splash-fixture-key' }, { path: '/status', authorization: 'Bearer splash-fixture-key' }]);
  expect(JSON.stringify(first)).not.toContain('splash-fixture-key');
});

test('redirects stop discovery before credentials or fallback requests', async () => {
  let requests = 0;
  const client = new RuntimeClient({ readConfig: async () => configuration(connection('local', null, 8000, 'fixture-key')), fetchImpl: async (_url, init) => {
    requests++; expect(init?.redirect).toBe('manual'); expect(new Headers(init?.headers).has('authorization')).toBe(false);
    return new Response('', { status: 302, headers: { location: 'http://127.0.0.1:9000' } });
  } });
  expect((await client.read()).status).toMatchObject({ state: 'failing', reason: 'runtime_unreachable' });
  expect(requests).toBe(1);
});

test('configuration changes invalidate an adapter and its credential immediately after refresh', async () => {
  let now = 1000, key = 'first-fixture';
  const sent: Array<string | null> = [];
  const client = new RuntimeClient({ now: () => now, readConfig: async () => configuration(connection('local', 'lmstudio', 8000, key)), fetchImpl: async (_url, init) => {
    sent.push(new Headers(init?.headers).get('authorization')); return json({ models: [] });
  } });
  const first = await client.read();
  expect((await client.read()).meta.connection.generation).toBe(first.meta.connection.generation);
  key = 'replacement-fixture'; now += 5000;
  const second = await client.read();
  expect(second.meta.connection.generation).toBeGreaterThan(first.meta.connection.generation);
  expect(sent).toEqual(['Bearer first-fixture', 'Bearer replacement-fixture']);
});

test('endpoint replacement and service recreation change the connection generation without exposing the endpoint', async () => {
  let now = 1000, port = 8000;
  const options = { now: () => now, readConfig: async () => configuration(connection('local', 'lmstudio', port)), fetchImpl: async () => json({ models: [] }) };
  const client = new RuntimeClient(options);
  const first = await client.read();
  port = 8001; now += 5000;
  const second = await client.read();
  const restarted = await new RuntimeClient(options).read();
  const markers = [first, second, restarted].map(reading => reading.meta.compat.connection?.generation);
  expect(markers.every(marker => typeof marker === 'string' && marker.length === 36)).toBe(true);
  expect(new Set(markers).size).toBe(3);
  expect(second.meta.connection.generation).toBeGreaterThan(first.meta.connection.generation);
  expect([second.meta.connection.id, second.meta.connection.runtime]).toEqual([first.meta.connection.id, first.meta.connection.runtime]);
  expect(JSON.stringify({ ...second, meta: { ...second.meta, port: null } })).not.toContain('127.0.0.1');
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
  expect((await client.read()).status.state).toBe('failing');
  expect(performance.now() - start).toBeLessThan(220);
  expect(requests).toBe(2);
  expect(signals.every(signal => signal.aborted)).toBe(true);
});

test('each LM Studio connection gets the activity view for its own port', async () => {
  const ports: Array<number | null> = [];
  let touched = 0;
  const activity = { available: true, stop: () => {}, forPort: (port: number | null) => { ports.push(port); return { touch: () => { touched += 1; }, view: () => null }; } };
  const client = new RuntimeClient({ lmstudioActivity: activity as never,
    readConfig: async () => configuration(connection('bionic', 'lmstudio', 1234), connection('tunnel', 'lmstudio', 1235)), fetchImpl: async () => json({ models: [] }) });
  await client.read({ provider: 'bionic', runtime: null });
  await client.read({ provider: 'tunnel', runtime: null });
  expect(ports).toEqual([1234, 1235]);
  expect(touched).toBe(2);
});

test('every collection gets its own deadline, however long an adapter lives', async () => {
  const replies: Record<string, unknown> = { '/api/v1/models': { models: [] }, '/health': { status: 'ok' }, '/v1/models': { object: 'list', data: [] },
    '/status': { ready: true, requests: { completed: 1, failed: 0 } } };
  const vllm = { '/health': { status: 'healthy', model_loaded: true, model_name: 'fixture', engine_type: 'batched', model_type: 'llm', available_models: [] },
    '/v1/status': { status: 'running', model: 'fixture', num_running: 0, num_waiting: 0, requests: [] } };
  for (const runtime of ['lmstudio', 'mlx-lm', 'splash', 'vllm-mlx'] as const) {
    let now = 1000, requests = 0;
    const table: Record<string, unknown> = runtime === 'vllm-mlx' ? vllm : replies;
    const client = new RuntimeClient({ now: () => now, readConfig: async () => configuration(connection('local', runtime)),
      fetchImpl: async url => { requests += 1; const body = table[path(url)]; return body ? json(body) : json({}, 404); } });
    for (let poll = 0; poll < 6; poll += 1, now += 5_000) expect((await client.read()).status.state, `${runtime} at ${now - 1000} ms`).toBe('ready');
    expect(requests, runtime).toBeGreaterThanOrEqual(6);
  }
});

test('adapters see only paths on their own origin: an absolute URL never leaves with the key', async () => {
  const seen: string[] = [];
  const probe: DescriptorV2 = { id: 'splash', hints: () => false, detect: [], cadence: () => 1_000, capabilities: [], identityEveryMs: 60_000,
    create: context => ({ identity: async () => true, dispose() {}, read: async () => {
      const outcomes = [];
      for (const target of ['http://198.51.100.1/steal', '//198.51.100.1/steal', 'relative']) {
        outcomes.push(await context.get(target).then(() => 'sent', error => String(error.message)));
      }
      seen.push(...outcomes);
      return { at: context.now(), status: { state: 'ready', reason: null, params: {} }, capabilities: {}, identity: {}, completions: [],
        runtime: { phase: 'idle', request: null, server: { active: null, queued: null }, memory: {}, residency: [], slots: [], catalog: [], engines: [] } };
    } }) };
  let requests = 0;
  const client = new RuntimeClient({ descriptors: [probe], readConfig: async () => configuration(connection('local', 'splash', 8000, 'fixture-key')),
    fetchImpl: async () => { requests += 1; return json({}); } });
  await client.read();
  expect([seen, requests]).toEqual([Array(3).fill('Only paths on the connection are read.'), 0]);
});

// ---- Stage 2b: re-detection, explicit runtimes, Automatic + explicit, optional endpoints ----

type Routes = Record<string, unknown>;
const SPLASH: Routes = { '/health': { status: 'ok' }, '/status': { ready: true, instance: { model: 'example/Example-27B-Splash' }, requests: { submitted: 3, completed: 3, failed: 0 } } };
const VLLM: Routes = { '/health': { status: 'healthy', model_loaded: true, model_name: 'fixture', engine_type: 'batched', model_type: 'llm', available_models: ['fixture'] },
  '/v1/status': { status: 'running', model: 'fixture', num_running: 0, num_waiting: 0, requests: [] } };
/** One loopback port whose server can be swapped or stopped, with a controllable clock. */
const port = (initial: Routes | null) => {
  const state = { now: 1_000, server: initial, calls: [] as string[] };
  const fetchImpl = async (url: RequestInfo | URL) => {
    state.calls.push(path(url));
    if (!state.server) throw new TypeError('fetch failed');
    const body = state.server[path(url)];
    return body === undefined ? json({ detail: 'Not Found' }, 404) : json(body);
  };
  return { state, fetchImpl, now: () => state.now };
};
/** Polls like a visible panel: every 500 ms, answered from cache or a fresh collection. */
const poll = async (client: RuntimeClient, clock: { now: number }, ms: number, selection?: ReadSelection) => {
  let last!: RuntimeReading;
  for (const end = clock.now + ms; clock.now < end; clock.now += 500) last = await client.read(selection);
  return last;
};

test('port swap Splash → vllm-mlx → Splash: three unsupported readings re-detect, switch adapters and bump the generation', async () => {
  const net = port(SPLASH);
  const client = new RuntimeClient({ now: net.now, fetchImpl: net.fetchImpl, readConfig: async () => configuration(connection('local', null)) });
  const splash = await poll(client, net.state, 1_000);
  expect(splash.meta.connection).toMatchObject({ runtime: 'splash', detection: { basis: 'probe', probe: '/status' } });
  expect(splash.status.state).toBe('ready');
  net.state.server = VLLM; net.state.now += 2_000;
  // The Splash adapter now reads a 404 on /status: another server answers, so each reading is degraded, not failing.
  const degraded = await client.read();
  expect(degraded.status).toEqual({ state: 'degraded', reason: 'unsupported_contract', params: { port: 8000 } });
  expect(degraded.meta.failures).toBe(0);
  const vllm = await poll(client, net.state, 8_000);
  expect(vllm.meta.connection).toMatchObject({ runtime: 'vllm-mlx', detection: { basis: 'probe', confidence: 'medium', probe: '/health' } });
  expect([vllm.status.state, vllm.runtime.phase]).toEqual(['ready', 'idle']);
  expect(vllm.meta.connection.generation).toBeGreaterThan(splash.meta.connection.generation);
  net.state.server = SPLASH;
  const back = await poll(client, net.state, 8_000);
  expect(back.meta.connection).toMatchObject({ runtime: 'splash', detection: { probe: '/status' } });
  expect(back.status.state).toBe('ready');
  expect(back.meta.connection.generation).toBeGreaterThan(vllm.meta.connection.generation);
  // Detection passes ran only on the swaps, never on healthy polls.
  expect(net.state.calls.filter(call => call === '/lmstudio-greeting')).toHaveLength(2);
});

test('the first answer after 30 s unreachable re-detects: a port swap across downtime', async () => {
  const net = port(SPLASH);
  const client = new RuntimeClient({ now: net.now, fetchImpl: net.fetchImpl, readConfig: async () => configuration(connection('local', null)) });
  const splash = await poll(client, net.state, 1_000);
  net.state.server = null;
  const down = await poll(client, net.state, 31_000);
  const sinceAt = Number(down.status.params.sinceAt);
  expect(down.status).toEqual({ state: 'failing', reason: 'runtime_unreachable', params: { port: 8000, sinceAt } });
  // When the episode began: the first failed read after the last answer, not this poll.
  expect(sinceAt).toBeGreaterThan(splash.at);
  expect(sinceAt).toBeLessThanOrEqual(splash.at + 2_500);
  net.state.server = VLLM;
  const after = await poll(client, net.state, 6_000);
  expect(after.meta.connection.runtime).toBe('vllm-mlx');
  expect(after.status.state).toBe('ready');
});

/** A runtime whose readings always look fine: only identity() can tell that another server took the port. */
const lookalike = (id: RuntimeKind, identityEveryMs: number, checks: { count: number }): DescriptorV2 => ({
  id, hints: () => false, identityEveryMs, capabilities: [], cadence: () => 1_000,
  detect: [{ probe: '/status', confidence: 'high', match: ({ status, body }) => status === 200 && body?.kind === id }],
  create: context => ({
    identity: async () => { checks.count += 1; return (await context.get('/status')).body?.kind === id; }, dispose() {},
    read: async (): Promise<AdapterReadingV2> => ({ at: context.now(), status: { state: 'ready', reason: null, params: {} }, capabilities: {}, identity: {}, completions: [],
      runtime: { phase: 'idle', request: null, server: { active: null, queued: null }, memory: {}, residency: [], slots: [], catalog: [], engines: [] } }),
  }),
});

test('identity() is checked every 60 s (oMLX every 300 s); a failure re-detects and switches an automatic connection', async () => {
  const checks = { count: 0 };
  const net = port({ '/status': { kind: 'splash' } });
  const client = new RuntimeClient({ now: net.now, fetchImpl: net.fetchImpl, readConfig: async () => configuration(connection('local', null)),
    descriptors: [lookalike('splash', 60_000, checks), lookalike('vllm-mlx', 60_000, checks), lookalike('omlx', 300_000, checks)] });
  const first = await poll(client, net.state, 30_000);
  expect([first.meta.connection.runtime, checks.count]).toEqual(['splash', 0]);
  net.state.server = { '/status': { kind: 'vllm-mlx' } };
  expect((await poll(client, net.state, 29_000)).meta.connection.runtime).toBe('splash');
  const switched = await poll(client, net.state, 3_000);
  expect([switched.meta.connection.runtime, checks.count]).toEqual(['vllm-mlx', 1]);
  expect(switched.meta.connection.generation).toBeGreaterThan(first.meta.connection.generation);
  // oMLX's identity interval is five minutes.
  const omlxChecks = { count: 0 };
  const omlx = port({ '/status': { kind: 'omlx' } });
  const slow = new RuntimeClient({ now: omlx.now, fetchImpl: omlx.fetchImpl, readConfig: async () => configuration(connection('local', null)),
    descriptors: [lookalike('omlx', 300_000, omlxChecks)] });
  await poll(slow, omlx.state, 299_000);
  expect(omlxChecks.count).toBe(0);
  await poll(slow, omlx.state, 2_000);
  expect(omlxChecks.count).toBe(1);
});

test('an explicit runtime is never switched: re-detection reports runtime_changed until the chosen runtime answers again', async () => {
  const checks = { count: 0 };
  const net = port({ '/status': { kind: 'splash' } });
  const client = new RuntimeClient({ now: net.now, fetchImpl: net.fetchImpl, readConfig: async () => configuration(connection('local', null)),
    descriptors: [lookalike('splash', 60_000, checks), lookalike('vllm-mlx', 60_000, checks)] });
  const selection = { provider: 'local', runtime: 'splash' as const };
  const first = await poll(client, net.state, 2_000, selection);
  expect(first.meta.connection).toMatchObject({ runtime: 'splash', detection: { basis: 'explicit', confidence: 'high' } });
  net.state.server = { '/status': { kind: 'vllm-mlx' } };
  const changed = await poll(client, net.state, 62_000, selection);
  expect(changed.status).toEqual({ state: 'degraded', reason: 'runtime_changed', params: { detected: 'vllm-mlx', port: 8000 } });
  expect(changed.meta.connection).toMatchObject({ runtime: 'splash', generation: first.meta.connection.generation, detection: { basis: 'explicit' } });
  net.state.server = { '/status': { kind: 'splash' } };
  const back = await poll(client, net.state, 1_500, selection);
  expect(back.status).toEqual({ state: 'ready', reason: null, params: {} });
  expect(back.meta.connection.generation).toBe(first.meta.connection.generation);
});

test('an explicit Splash on a port vllm-mlx took over: real adapters report the change without switching', async () => {
  const net = port(SPLASH);
  const client = new RuntimeClient({ now: net.now, fetchImpl: net.fetchImpl, readConfig: async () => configuration(connection('local', null)) });
  const selection = { provider: 'local', runtime: 'splash' as const };
  await poll(client, net.state, 1_000, selection);
  net.state.server = VLLM;
  const changed = await poll(client, net.state, 10_000, selection);
  expect([changed.status.reason, changed.status.params, changed.meta.connection.runtime]).toEqual(['runtime_changed', { detected: 'vllm-mlx', port: 8000 }, 'splash']);
  expect(net.state.calls).not.toContain('/v1/status');
  net.state.server = SPLASH;
  expect((await poll(client, net.state, 3_000, selection)).status.state).toBe('ready');
});

test('Automatic + an explicit runtime keeps its 1.6 meaning, tested with a selection a 1.6 panel persisted', async () => {
  // panel/connections-view.ts stored {provider:'', runtime} for "Automatic" with a chosen runtime; the query carries only runtime.
  const persisted = JSON.parse('{"provider":"","runtime":"splash"}') as { provider: string; runtime: 'splash' };
  const calls: string[] = [];
  const client = new RuntimeClient({ readConfig: async () => configuration(connection('omlx', 'omlx', 8001), connection('splish', 'splash', 8000), connection('custom', null, 8002)),
    fetchImpl: async url => { calls.push(`${new URL(String(url)).port}${path(url)}`); return json(SPLASH[path(url)] ?? {}, SPLASH[path(url)] ? 200 : 404); } });
  const reading = await client.read(persisted);
  expect(reading.meta.connection).toMatchObject({ id: 'splish', runtime: 'splash', detection: { basis: 'explicit' } });
  expect(calls).toEqual(['8000/status']);
  // No hint names it: a connection whose automatic slot detected it wins, else the first connection is read as that runtime (1.6).
  const detectedFirst = new RuntimeClient({ readConfig: async () => configuration(connection('local-a', null, 8001), connection('local-b', null, 8000)),
    fetchImpl: async url => new URL(String(url)).port === '8000' && SPLASH[path(url)] ? json(SPLASH[path(url)]) : json({}, 404) });
  await detectedFirst.read({ provider: 'local-b', runtime: null });
  expect((await detectedFirst.read(persisted)).meta.connection.id).toBe('local-b');
  const fallback = new RuntimeClient({ readConfig: async () => configuration(connection('first', null, 8000), connection('second', 'omlx', 8001)), fetchImpl: async () => json(SPLASH['/status']) });
  expect((await fallback.read(persisted)).meta.connection).toMatchObject({ id: 'first', runtime: 'splash' });
  // And a 1.6 provider id outside the old [A-Za-z0-9._-]{1,64} grammar selects its connection unchanged.
  const long = 'My LM Studio (Bionic) · work'.padEnd(120, '.');
  const named = new RuntimeClient({ readConfig: async () => configuration(connection(long, 'lmstudio', 1234)), fetchImpl: async () => json({ models: [] }) });
  expect((await named.read({ provider: long, runtime: null })).meta.connection).toMatchObject({ id: long, runtime: 'lmstudio' });
});

test('detection that finds nothing is unsupported_runtime; a locked port is authentication_failed; both retry with a backoff', async () => {
  let now = 1_000, requests = 0;
  const client = new RuntimeClient({ now: () => now, readConfig: async () => configuration(connection('local', null, 8000, 'fixture-key')),
    fetchImpl: async url => { requests += 1; return path(url) === '/status' ? json({}, 401) : json({}, 404); } });
  const locked = await client.read();
  expect(locked.status).toEqual({ state: 'failing', reason: 'authentication_failed', params: { port: 8000, keySaved: true } });
  const sent = requests;
  now += 500; await client.read();
  expect(requests).toBe(sent);
  now += 1_000; await client.read();
  expect(requests).toBeGreaterThan(sent);
});

test('a reading from a glance frame is refreshed for the Server tab once the floor has passed', async () => {
  let now = 1_000, requests = 0;
  const client = new RuntimeClient({ now: () => now, readConfig: async () => configuration(connection('studio', 'lmstudio')), fetchImpl: async () => { requests += 1; return json({ models: [] }); } });
  await client.read(undefined, { tier: 'glance', detail: false });
  now += 100; await client.read(undefined, { tier: 'full', detail: true });
  expect(requests).toBe(1);
  now += 400; await client.read(undefined, { tier: 'full', detail: true });
  expect(requests).toBe(2);
  now += 1_000; await client.read(undefined, { tier: 'glance', detail: false });
  expect(requests).toBe(2);
});

test('finished requests become completions once, with service-wide seqs, and no reading carries English or credentials', async () => {
  const last = { model: 'fixture-model', tokensPerSecond: 38.6, ttftSeconds: 0.47, promptTokens: 1840, cachedTokens: 1126, outputTokens: 109, finishedAt: 5 };
  let view = { active: null, concurrent: false, activeRequests: 0, lastRequest: last, completedRequests: 1, averageDecodeTPS: 38.6, cacheEfficiencyPercent: 61.2 };
  const activity = { available: true, stop() {}, forPort: () => ({ touch() {}, view: () => view }) };
  let now = 1_000;
  const client = new RuntimeClient({ now: () => now, lmstudioActivity: activity as never, instance: '5c1e0a7b',
    readConfig: async () => configuration(connection('bionic', 'lmstudio', 1234, 'fixture-key')), fetchImpl: async () => json({ models: [] }) });
  const first = await client.read();
  expect(first.meta.completions?.since(undefined, () => undefined)).toMatchObject({ instance: '5c1e0a7b', cursor: 1, reset: false,
    items: [{ seq: 1, model: 'fixture-model', basis: 'reported', decodeTps: 38.6, ttftMs: 470, overlapped: true, host: {} }] });
  now += 1_000; await client.read();
  expect(client.completionHead).toBe(1);
  view = { ...view, lastRequest: { ...last, finishedAt: 9, outputTokens: 12 }, completedRequests: 2 };
  now += 1_000; const second = await client.read();
  expect(second.meta.completions?.since(1, () => undefined).items.map(item => item.seq)).toEqual([2]);
  expect(second.meta.completions?.since(7, () => undefined)).toMatchObject({ reset: true, cursor: 2 });
  expect(client.completionHead).toBe(2);
  expect(JSON.stringify(second)).not.toMatch(/fixture-key|Last response|tok\/s/);
  expect(second.meta.compat.message).toBeNull();
});
