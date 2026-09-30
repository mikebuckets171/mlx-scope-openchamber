import { afterEach, expect, test } from 'bun:test';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import corpus from '../tests/fixtures/omlx-monitoring.json';
import { hostFromV1 } from '../src/contract/convert-v1.ts';
import { classAKeys } from '../src/contract/guards.ts';
import type { RuntimeKind } from '../src/contract/runtime.ts';
import { honestyViolations, parseSnapshotV2, type SnapshotV2 } from '../src/contract/snapshot.ts';
import { rendered, toV1 } from '../src/contract/testing/v1-inverse.ts';
import { unitViolations } from '../src/contract/units.ts';
import { parseSystemSnapshot } from '../src/system.ts';
import { parseTelemetrySnapshot, unavailableTelemetry, type TelemetrySnapshot } from '../src/telemetry.ts';
import type { RuntimeConnectionConfig } from './config.ts';
import { requestJSON } from './http.ts';
import { LMStudioClient } from './lmstudio.ts';
import type { LMStudioActivityView } from './lmstudio-activity.ts';
import { OmlxClient } from './omlx-client.ts';
import { RuntimeClient } from './runtime-client.ts';
import { createScopeServer } from './server.ts';
import { SplashClient } from './splash.ts';

// Per runtime: fixture → adapter → /v2/snapshot over HTTP → parseSnapshotV2. For the runtimes still on the 2b bridge
// (oMLX, LM Studio, Splash), the 1.6 panel renders exactly what it rendered from the 1.x client's own reading, apart from
// the English line, which the panel now words from the reason code. vllm-mlx and mlx-lm are v2-native.
const NOW = Date.UTC(2026, 0, 15, 9, 30), INSTANCE = '5c1e0a7b';
const SYSTEM = parseSystemSnapshot({ platform: 'darwin', cpuModel: 'Apple M-series · fixture', logicalCores: 14, cpuPercent: 23.5,
  memoryUsedGB: 36.1, memoryTotalGB: 51.539607552, macOS: { wiredGB: 4.831838208, compressedGB: 3.006477107, swapUsedGB: 1.181116006, sampledAt: NOW - 3_000 },
  sampledAt: NOW - 1_000 })!;
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
});
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

type Routes = Record<string, unknown>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const link = (id: string, runtime: RuntimeKind | null, port = 8000): RuntimeConnectionConfig => ({ id, label: `Local ${id}`, runtime: runtime as RuntimeConnectionConfig['runtime'],
  config: { baseURL: new URL(`http://127.0.0.1:${port}/`), apiKey: null, preferredModel: null, issue: 'missing_credential', source: 'opencode',
    configStatus: 'present', authStatus: 'present', error: null } });
const activity = (view: LMStudioActivityView) => ({ available: true, stop() {}, forPort: () => ({ touch() {}, view: () => view }) });
const table = (routes: Routes | Routes[], poll: number) => async (url: RequestInfo | URL) => {
  const current = Array.isArray(routes) ? routes[Math.min(poll, routes.length - 1)]! : routes, path = new URL(String(url)).pathname;
  if (!(path in current)) return json({ error: 'Unexpected endpoint' }, 404);
  return typeof current[path] === 'number' ? json({}, current[path] as number) : json(current[path]);
};

/** Polls `/v2/snapshot` once a second; `bridge` also reads the same routes with the 1.x client, as the oracle. */
const serve = async (connection: RuntimeConnectionConfig, routes: Routes | Routes[], { polls = 1, query = `provider=${encodeURIComponent(connection.id)}`, stream, bridge }: {
  polls?: number; query?: string; stream?: LMStudioActivityView; bridge?: 'omlx' | 'lmstudio' | 'splash' } = {}) => {
  let now = NOW, poll = 0;
  const fetchImpl = (url: RequestInfo | URL) => table(routes, poll)(url);
  const client = new RuntimeClient({ now: () => now, lmstudioActivity: stream ? activity(stream) as never : null, instance: INSTANCE, fetchImpl,
    readConfig: async () => ({ connections: [connection], issue: 'none', error: null }) });
  const base = connection.config.baseURL!, reader = async (path: string) => (await requestJSON({ url: new URL(path, base), fetchImpl, allowLoadingHealth: path === '/health' })).body;
  const oracle = bridge === 'omlx' ? new OmlxClient({ fetchImpl, now: () => now, readConfig: async () => connection.config })
    : bridge === 'splash' ? new SplashClient(reader, () => now) : bridge === 'lmstudio' ? new LMStudioClient(reader, () => now, stream ? activity(stream).forPort() : null) : null;
  const server = createScopeServer('test-token', { read: (selection, request) => client.read(selection, request), host: async () => hostFromV1(SYSTEM),
    completionHead: () => client.completionHead }, { version: '2.0.0', instance: INSTANCE, now: () => now, monotonic: () => now });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const results: Array<{ body: SnapshotV2; v1: TelemetrySnapshot | null }> = [];
  for (; poll < polls; poll += 1, now += 1_000) {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/snapshot?${query}`, { headers: { Authorization: 'Bearer test-token' } });
    expect(response.status).toBe(200);
    const v1 = oracle ? await oracle.snapshot().catch((error: Error) => unavailableTelemetry('runtime_unreachable', error.message, now)) : null;
    results.push({ body: await response.json(), v1 });
  }
  return results;
};

/** Canonical, honest and clean; for a bridged runtime, the 1.6 panel renders what the 1.x reading rendered (English aside). */
const expectRoundTrip = (name: string, { body, v1 }: { body: SnapshotV2; v1: TelemetrySnapshot | null }): SnapshotV2 => {
  const parsed = parseSnapshotV2(body);
  expect(parsed, name).toEqual(body);
  expect([honestyViolations(body), unitViolations(body), classAKeys(body)], name).toEqual([[], [], []]);
  expect(body.compat?.message, name).toBeNull();
  if (v1) {
    const inverse = parseTelemetrySnapshot(wire(toV1(parsed!)));
    const original = parseTelemetrySnapshot(wire({ ...v1, message: null, connection: inverse.connection, system: SYSTEM }));
    expect(rendered(inverse, NOW + 60_000), name).toEqual(rendered(original, NOW + 60_000));
  }
  return parsed!;
};

const omlx = (name: string): Routes => {
  const item = corpus.cases.find(entry => entry.name === name)! as { activity: unknown; stats?: unknown; contextWindows?: Record<string, number> };
  return { '/health': { status: 'healthy', engine_pool: { model_count: 1 } }, '/admin/api/activity': item.activity, '/admin/api/stats': item.stats ?? 404,
    '/v1/models/status': { models: Object.entries(item.contextWindows ?? {}).map(([id, limit]) => ({ id, max_context_window: limit })) } };
};
test('oMLX (bridged): decode, prefill, an auto-detected idle server and an explicit choice', async () => {
  for (const name of ['decode with request-matched cache', 'prefill with request-matched cache', 'stale prefill', 'concurrent text models', 'DFlash primary accepted output']) {
    const [result] = await serve(link('omlx', 'omlx'), omlx(name), { bridge: 'omlx' });
    const body = expectRoundTrip(`oMLX ${name}`, result!);
    expect(body.connection).toMatchObject({ id: 'omlx', runtime: 'omlx', detection: { basis: 'hint', confidence: 'medium' } });
    expect(body.capabilities['server.requests']).toEqual({ scope: 'server', basis: 'reported' });
  }
  const [decode] = await serve(link('omlx', 'omlx'), omlx('decode with request-matched cache'), { bridge: 'omlx' });
  expect(decode!.body.runtime.phase).toBe('decode');
  expect(decode!.body.runtime.request?.decodeTps).toBe(decode!.v1!.liveDecodeTPS!);
  const [detected] = await serve(link('local', null), omlx('resident idle'), { bridge: 'omlx' });
  expect(expectRoundTrip('oMLX detected', detected!).connection).toMatchObject({ runtime: 'omlx', detection: { basis: 'probe', confidence: 'high', probe: '/health' } });
  const [explicit] = await serve(link('local', null), omlx('resident idle'), { query: 'provider=local&runtime=omlx', bridge: 'omlx' });
  expect(expectRoundTrip('oMLX explicit', explicit!).connection.detection).toEqual({ basis: 'explicit', confidence: 'high' });
});

const lmModels = { models: [
  { type: 'llm', key: 'fixture/model', format: 'mlx', max_context_length: 32768, loaded_instances: [{ id: 'fixture/loaded', config: { context_length: 8192 } }] },
  { type: 'llm', key: 'fixture/other', format: 'gguf', max_context_length: 4096, loaded_instances: [] }] };
const lastRequest = { model: 'fixture-splash', tokensPerSecond: 38.6, ttftSeconds: 0.47, promptTokens: 18_400, cachedTokens: 11_260, outputTokens: 1092, finishedAt: NOW - 42_000 };
const view = (overrides: Partial<LMStudioActivityView>): LMStudioActivityView => ({ active: null, concurrent: false, activeRequests: 0,
  lastRequest: null, completedRequests: 0, averageDecodeTPS: null, cacheEfficiencyPercent: null, ...overrides });
test('LM Studio and Splash via Bionic (bridged): inventory, live activity and the last finished request', async () => {
  const [inventory] = await serve(link('studio', 'lmstudio'), { '/api/v1/models': lmModels }, { bridge: 'lmstudio' });
  expect(expectRoundTrip('LM Studio inventory', inventory!).runtime).toMatchObject({ phase: 'unknown', residencyCount: 1,
    catalog: [{ name: 'fixture/model', format: 'mlx', loaded: true, contextWindowTokens: 8192 }, { name: 'fixture/other', format: 'gguf', loaded: false, contextWindowTokens: 4096 }] });
  const legacy = { '/api/v1/models': { error: 'Unexpected endpoint or method.' }, '/api/v0/models': { object: 'list', data: [
    { id: 'fixture-splash', type: 'llm', state: 'loaded', compatibility_type: 'splash', max_context_length: 262144 }] } };
  const decode = view({ active: { model: 'fixture-splash', phase: 'decode', progress: null, startedAt: NOW - 9_000, requests: 1 }, activeRequests: 1, lastRequest, completedRequests: 1, averageDecodeTPS: 38.6 });
  const prefill = view({ active: { model: 'fixture-splash', phase: 'prefill', progress: 0.42, startedAt: NOW - 6_400, requests: 1 }, activeRequests: 1 });
  for (const [name, stream] of [['decode', decode], ['prefill', prefill], ['idle after a response', view({ lastRequest, completedRequests: 3, averageDecodeTPS: 37.9, cacheEfficiencyPercent: 61.2 })]] as const) {
    const results = await serve(link('bionic', 'lmstudio', 1234), legacy, { stream, polls: 2, bridge: 'lmstudio' });
    for (const result of results) {
      const body = expectRoundTrip(`Bionic ${name}`, result);
      expect(body.connection).toMatchObject({ id: 'bionic', runtime: 'lmstudio', engine: 'splash', host: 'bionic' });
      // Scope tallies the log stream itself, so counts and elapsed time are its observation.
      expect([body.capabilities['server.requests']?.basis, body.capabilities['request.elapsed']?.basis]).toEqual(['observed', 'observed']);
    }
    // The same finished request keeps its seq across polls.
    expect(results.map(result => result.body.completions.items.map(item => item.seq)), name).toEqual(stream.lastRequest ? [[1], [1]] : [[], []]);
  }
  const [done] = await serve(link('bionic', 'lmstudio', 1234), legacy, { stream: decode });
  expect(done!.body.completions).toEqual({ instance: INSTANCE, cursor: 1, reset: false, items: [{ seq: 1, finishedAt: NOW - 42_000, startedAt: null,
    model: 'fixture-splash', basis: 'reported', promptTokens: 18_400, cachedTokens: 11_260, outputTokens: 1092, ttftMs: 470, decodeTps: 38.6, overlapped: true, host: {} }] });
});

const splash = (overrides: Record<string, unknown> = {}) => ({ '/status': { ready: true, maximum_context_tokens: 262_144,
  instance: { model: 'example/Example-27B-Splash', pid: 4242 }, requests: { submitted: 18, completed: 17, cancelled: 1, failed: 0 },
  metrics: { decode_tokens_per_second: 47.2 }, memory_actual: { current_bytes: 12_500_000_000, peak_bytes: 13_000_000_000 }, ...overrides } });
test('Splash (bridged): idle, busy and loading, with Metal memory as the runtime reported it', async () => {
  const [idle] = await serve(link('splash', 'splash'), splash(), { bridge: 'splash' });
  expect(expectRoundTrip('Splash idle', idle!).runtime).toMatchObject({ phase: 'idle', memory: { metalBytes: 12_500_000_000, metalPeakBytes: 13_000_000_000 },
    server: { active: 0, averages: { decodeTps: 47.2, requestsTotal: 17, failedTotal: 0 } } });
  expect(idle!.body.capabilities['server.requests']?.basis).toBe('derived');
  const [busy] = await serve(link('splash', 'splash'), splash({ requests: { submitted: 21, completed: 17, cancelled: 1, failed: 1 } }), { bridge: 'splash' });
  expect(expectRoundTrip('Splash busy', busy!).runtime).toMatchObject({ phase: 'processing', server: { active: 2 } });
  const [loading] = await serve(link('splash', 'splash'), splash({ ready: false }), { bridge: 'splash' });
  expect(expectRoundTrip('Splash loading', loading!).status).toEqual({ state: 'degraded', reason: 'loading', params: {} });
  const [detected] = await serve(link('local', null), { '/health': 404, '/api/v1/models': 404, ...splash() }, { bridge: 'splash' });
  expect(expectRoundTrip('Splash detected', detected!).connection.detection).toEqual({ basis: 'probe', confidence: 'medium', probe: '/status' });
  expect(JSON.stringify([idle, busy, loading].map(result => result!.body))).not.toContain('4242');
});

test('mlx-lm (v2): reachability and the downloaded catalog, never live readings; a failing catalogue only drops the catalog', async () => {
  const cases = [['catalog', { '/health': { status: 'ok' }, '/v1/models': { object: 'list', data: [{ id: '/models/example/Example-4bit' }, { id: 'other' }] } }, 'ready'],
    ['no catalog', { '/health': { status: 'ok' }, '/v1/models': 500 }, 'ready'], ['down', { '/health': { status: 'down' } }, 'failing']] as const;
  for (const [name, routes, state] of cases) {
    const [result] = await serve(link('mlx', 'mlx-lm'), routes as Routes);
    const body = expectRoundTrip(`mlx-lm ${name}`, result!);
    expect([body.status.state, body.runtime.request, body.runtime.server.active], name).toEqual([state, null, null]);
  }
  const [catalog] = await serve(link('mlx', 'mlx-lm'), { '/health': { status: 'ok' }, '/v1/models': { object: 'list', data: [{ id: '/models/example/Example-4bit' }] } });
  expect(catalog!.body.runtime.catalog).toEqual([{ name: 'Example-4bit', format: 'mlx', loaded: null, contextWindowTokens: null }]);
  const [none] = await serve(link('mlx', 'mlx-lm'), { '/health': { status: 'ok' }, '/v1/models': 500 });
  expect([none!.body.capabilities['server.catalog'], none!.body.compat?.connection?.coverage]).toEqual([undefined, 'inventory']);
});

const vllmRequest = (extra: Record<string, unknown> = {}) => ({ request_id: 'fixture-request', status: 'running', phase: 'generation',
  prompt_tokens: 1000, completion_tokens: 100, tokens_per_second: 50, elapsed_s: 3, cached_tokens: 500, cache_hit_type: 'prefix', ...extra });
const vllm = (status: Record<string, unknown>, health: unknown = { status: 'healthy', model_loaded: true, model_name: 'example-model', engine_type: 'batched',
  model_type: 'llm', available_models: ['example-model'] }) => ({ '/health': health, '/v1/status': { status: 'running', model: 'example-model', num_running: 1,
  num_waiting: 0, requests: [vllmRequest()], total_requests_processed: 10, uptime_s: 100, cache: { max_memory_mb: 2048, current_memory_mb: 1024.5, entry_count: 4 }, ...status } });
test('vllm-mlx (v2): a decoding request, a queue, concurrency, a registry and a missing /health', async () => {
  const decode = await serve(link('vllm', 'vllm-mlx'), [vllm({}), vllm({ requests: [vllmRequest({ completion_tokens: 125 })] })], { polls: 2 });
  decode.forEach((result, index) => expectRoundTrip(`vllm decode #${index}`, result));
  expect(decode[1]!.body.runtime).toMatchObject({ phase: 'decode', request: { decodeTps: 50, outputTokens: 125, cachedTokens: 500, promptTokens: 1000, elapsedMs: 3000 } });
  expect(decode[1]!.body.runtime.server.cache).toEqual({ ramBytes: Math.round(1024.5 * 1024 ** 2), ramEntries: 4 });
  expect(decode[1]!.body.compat).toMatchObject({ modelID: 'example-model', statsState: 'fresh', connection: { coverage: 'requests' } });
  expect(JSON.stringify(decode.map(result => result.body))).not.toContain('fixture-request');
  for (const [name, status, phase] of [['queued', { num_running: 0, num_waiting: 2, requests: [] }, 'queued'],
    ['concurrent', { num_running: 2, requests: [vllmRequest(), vllmRequest({ request_id: 'fixture-second' })] }, 'processing'],
    ['registry', { model_manager: { models: [{ id: '/models/example-a', loaded: true }, { id: 'example-b', loaded: false }] } }, 'unknown']] as const) {
    const [result] = await serve(link('vllm', 'vllm-mlx'), vllm(status));
    expect(expectRoundTrip(`vllm ${name}`, result!).runtime.phase).toBe(phase);
  }
  const [unhealthy] = await serve(link('vllm', 'vllm-mlx'), vllm({}, 404));
  expect(expectRoundTrip('vllm without /health', unhealthy!)).toMatchObject({ status: { state: 'ready' }, runtime: { request: { promptTokens: 1000 } } });
  expect(unhealthy!.body.runtime.request?.cachedTokens).toBeUndefined();
});

test('no supported runtime, and an unreachable one, are codes: the English is the panel\'s', async () => {
  const [unsupported] = await serve(link('custom', null), { '/health': 404, '/api/v1/models': 404, '/status': 404, '/v1/models': { data: [] } });
  expect(expectRoundTrip('unsupported', unsupported!).status).toEqual({ state: 'unconfigured', reason: 'unsupported_runtime', params: { port: 8000 } });
  expect(unsupported!.body.connection.detection).toEqual({ basis: 'probe', confidence: 'low' });
  expect(unsupported!.body.compat?.connection?.diagnostic).toBe('unsupported');
  const [down] = await serve(link('omlx', 'omlx'), { '/health': 500 });
  expect(expectRoundTrip('unreachable', down!).status).toMatchObject({ state: 'failing', reason: 'runtime_unreachable', params: { port: 8000 } });
  expect(down!.body.compat?.connection?.diagnostic).toBe('offline');
});
