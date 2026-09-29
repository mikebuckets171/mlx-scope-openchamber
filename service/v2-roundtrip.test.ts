import { afterEach, expect, test } from 'bun:test';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import corpus from '../tests/fixtures/omlx-monitoring.json';
import { classAKeys } from '../src/contract/guards.ts';
import { honestyViolations, parseSnapshotV2, type SnapshotV2 } from '../src/contract/snapshot.ts';
import { rendered, toV1 } from '../src/contract/testing/v1-inverse.ts';
import { unitViolations } from '../src/contract/units.ts';
import type { Runtime } from '../src/runtime.ts';
import { parseSystemSnapshot } from '../src/system.ts';
import { parseTelemetrySnapshot } from '../src/telemetry.ts';
import type { RuntimeConnectionConfig } from './config.ts';
import type { LMStudioActivityView } from './lmstudio-activity.ts';
import { RuntimeClient, type RuntimeReading } from './runtime-client.ts';
import { createScopeServer } from './server.ts';

// Per adapter: runtime fixture → 1.x reading → /v2/snapshot body over HTTP → parseSnapshotV2, with every value the
// 1.6 panel renders preserved at its precision.
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
const link = (id: string, runtime: Runtime | null, port = 8000): RuntimeConnectionConfig => ({ id, label: `Local ${id}`, runtime,
  config: { baseURL: new URL(`http://127.0.0.1:${port}/`), apiKey: null, preferredModel: null, issue: 'missing_credential', source: 'opencode',
    configStatus: 'present', authStatus: 'present', error: null } });
const activity = (view: LMStudioActivityView) => ({ available: true, stop() {}, forPort: () => ({ touch() {}, view: () => view }) });

/** Polls `/v2/snapshot` once a second; returns each body with the reading the service composed it from. */
const serve = async (connection: RuntimeConnectionConfig, routes: Routes | Routes[], { polls = 1, query = `provider=${connection.id}`, stream }: {
  polls?: number; query?: string; stream?: LMStudioActivityView } = {}) => {
  let now = NOW, poll = 0;
  const client = new RuntimeClient({ now: () => now, lmstudioActivity: stream ? activity(stream) as never : null,
    readConfig: async () => ({ connections: [connection], issue: 'none', error: null }),
    fetchImpl: async url => {
      const table = Array.isArray(routes) ? routes[Math.min(poll, routes.length - 1)]! : routes, path = new URL(String(url)).pathname;
      if (!(path in table)) return json({ error: 'Unexpected endpoint' }, 404);
      return typeof table[path] === 'number' ? json({}, table[path] as number) : json(table[path]);
    } });
  const readings: RuntimeReading[] = [];
  const server = createScopeServer('test-token', { read: async selection => { const reading = await client.read(selection); readings.push(reading); return reading; },
    system: async () => SYSTEM, completionHead: () => client.completionHead }, { version: '2.0.0', instance: INSTANCE, now: () => now, monotonic: () => now });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const results: Array<{ reading: RuntimeReading; body: SnapshotV2 }> = [];
  for (; poll < polls; poll += 1, now += 1_000) {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/snapshot?${query}`, { headers: { Authorization: 'Bearer test-token' } });
    expect(response.status).toBe(200);
    results.push({ reading: readings.at(-1)!, body: await response.json() });
  }
  return results;
};

/** The body is canonical, honest and clean, and the 1.6 panel would render exactly what it rendered from the 1.x reading. */
const expectRoundTrip = (name: string, { reading, body }: { reading: RuntimeReading; body: SnapshotV2 }): SnapshotV2 => {
  const parsed = parseSnapshotV2(body);
  expect(parsed, name).toEqual(body);
  expect([honestyViolations(body), unitViolations(body), classAKeys(body)], name).toEqual([[], [], []]);
  const original = parseTelemetrySnapshot(wire({ ...reading.snapshot, system: SYSTEM }));
  expect(rendered(parseTelemetrySnapshot(wire(toV1(parsed!))), NOW + 60_000), name).toEqual(rendered(original, NOW + 60_000));
  return parsed!;
};

const omlx = (name: string): Routes => {
  const item = corpus.cases.find(entry => entry.name === name)! as { activity: unknown; stats?: unknown; contextWindows?: Record<string, number> };
  return { '/health': { status: 'healthy', engine_pool: { model_count: 1 } }, '/admin/api/activity': item.activity, '/admin/api/stats': item.stats ?? 404,
    '/v1/models/status': { models: Object.entries(item.contextWindows ?? {}).map(([id, limit]) => ({ id, max_context_window: limit })) } };
};
test('oMLX: decode, prefill and an auto-detected idle server', async () => {
  for (const name of ['decode with request-matched cache', 'prefill with request-matched cache', 'stale prefill', 'concurrent text models', 'DFlash primary accepted output']) {
    const [result] = await serve(link('omlx', 'omlx'), omlx(name));
    const body = expectRoundTrip(`oMLX ${name}`, result!);
    expect(body.connection).toMatchObject({ id: 'omlx', runtime: 'omlx', detection: { basis: 'hint', confidence: 'medium' } });
    expect(body.capabilities['server.requests']).toEqual({ scope: 'server', basis: 'reported' });
  }
  const [decode] = await serve(link('omlx', 'omlx'), omlx('decode with request-matched cache'));
  expect(decode!.body.runtime.phase).toBe('decode');
  expect(decode!.body.runtime.request?.decodeTps).toBe(decode!.reading.snapshot.liveDecodeTPS!);
  const [detected] = await serve(link('local', null), omlx('resident idle'));
  expect(expectRoundTrip('oMLX detected', detected!).connection).toMatchObject({ runtime: 'omlx', detection: { basis: 'probe', confidence: 'high', probe: '/health' } });
  const [explicit] = await serve(link('local', null), omlx('resident idle'), { query: 'provider=local&runtime=omlx' });
  expect(expectRoundTrip('oMLX explicit', explicit!).connection.detection).toEqual({ basis: 'explicit', confidence: 'high' });
});

const lmModels = { models: [
  { type: 'llm', key: 'fixture/model', format: 'mlx', max_context_length: 32768, loaded_instances: [{ id: 'fixture/loaded', config: { context_length: 8192 } }] },
  { type: 'llm', key: 'fixture/other', format: 'gguf', max_context_length: 4096, loaded_instances: [] }] };
const lastRequest = { model: 'fixture-splash', tokensPerSecond: 38.6, ttftSeconds: 0.47, promptTokens: 18_400, cachedTokens: 11_260, outputTokens: 1092, finishedAt: NOW - 42_000 };
const view = (overrides: Partial<LMStudioActivityView>): LMStudioActivityView => ({ active: null, concurrent: false, activeRequests: 0,
  lastRequest: null, completedRequests: 0, averageDecodeTPS: null, cacheEfficiencyPercent: null, ...overrides });
test('LM Studio and Splash via Bionic: inventory, live activity and the last finished request', async () => {
  const [inventory] = await serve(link('studio', 'lmstudio'), { '/api/v1/models': lmModels });
  expect(expectRoundTrip('LM Studio inventory', inventory!).runtime).toMatchObject({ phase: 'unknown', residencyCount: 1,
    catalog: [{ name: 'fixture/model', format: 'mlx', loaded: true, contextWindowTokens: 8192 }, { name: 'fixture/other', format: 'gguf', loaded: false, contextWindowTokens: 4096 }] });
  const legacy = { '/api/v1/models': { error: 'Unexpected endpoint or method.' }, '/api/v0/models': { object: 'list', data: [
    { id: 'fixture-splash', type: 'llm', state: 'loaded', compatibility_type: 'splash', max_context_length: 262144 }] } };
  const decode = view({ active: { model: 'fixture-splash', phase: 'decode', progress: null, startedAt: NOW - 9_000, requests: 1 }, activeRequests: 1, lastRequest, completedRequests: 1, averageDecodeTPS: 38.6 });
  const prefill = view({ active: { model: 'fixture-splash', phase: 'prefill', progress: 0.42, startedAt: NOW - 6_400, requests: 1 }, activeRequests: 1 });
  for (const [name, stream] of [['decode', decode], ['prefill', prefill], ['idle after a response', view({ lastRequest, completedRequests: 3, averageDecodeTPS: 37.9, cacheEfficiencyPercent: 61.2 })]] as const) {
    const results = await serve(link('bionic', 'lmstudio', 1234), legacy, { stream, polls: 2 });
    for (const result of results) {
      const body = expectRoundTrip(`Bionic ${name}`, result);
      expect(body.connection).toMatchObject({ id: 'bionic', runtime: 'lmstudio', engine: 'splash', host: 'bionic' });
      // Scope tallies the log stream itself, so counts and elapsed time are its observation.
      expect([body.capabilities['server.requests']?.basis, body.capabilities['request.elapsed']?.basis]).toEqual(['observed', 'observed']);
    }
    // The same finished request keeps its seq across polls.
    const seqs = results.map(result => result.body.completions.items.map(item => item.seq));
    expect(seqs, name).toEqual(stream.lastRequest ? [[1], [1]] : [[], []]);
  }
  const [done] = await serve(link('bionic', 'lmstudio', 1234), legacy, { stream: decode });
  expect(done!.body.completions).toEqual({ instance: INSTANCE, cursor: 1, reset: false, items: [{ seq: 1, finishedAt: NOW - 42_000, startedAt: null,
    model: 'fixture-splash', basis: 'reported', promptTokens: 18_400, cachedTokens: 11_260, outputTokens: 1092, ttftMs: 470, decodeTps: 38.6, overlapped: true, host: {} }] });
});

test('mlx-lm: reachability and the downloaded catalog, never live readings', async () => {
  for (const [name, routes] of [['catalog', { '/health': { status: 'ok' }, '/v1/models': { object: 'list', data: [{ id: '/models/example/Example-4bit' }, { id: 'other' }] } }],
    ['no catalog', { '/health': { status: 'ok' }, '/v1/models': 500 }], ['down', { '/health': { status: 'down' } }]] as const) {
    const [result] = await serve(link('mlx', 'mlx-lm'), routes as Routes);
    const body = expectRoundTrip(`mlx-lm ${name}`, result!);
    expect([body.runtime.request, body.runtime.server.active]).toEqual([null, null]);
  }
  const [catalog] = await serve(link('mlx', 'mlx-lm'), { '/health': { status: 'ok' }, '/v1/models': { object: 'list', data: [{ id: '/models/example/Example-4bit' }] } });
  expect(catalog!.body.runtime.catalog).toEqual([{ name: 'Example-4bit', format: 'mlx', loaded: null, contextWindowTokens: null }]);
});

const vllmRequest = (extra: Record<string, unknown> = {}) => ({ request_id: 'fixture-request', status: 'running', phase: 'generation',
  prompt_tokens: 1000, completion_tokens: 100, tokens_per_second: 50, elapsed_s: 3, cached_tokens: 500, cache_hit_type: 'prefix', ...extra });
const vllm = (status: Record<string, unknown>) => ({ '/health': { status: 'healthy', model_loaded: true, model_name: 'example-model', engine_type: 'batched', model_type: 'llm' },
  '/v1/status': { status: 'running', model: 'example-model', num_running: 1, num_waiting: 0, requests: [vllmRequest()], total_requests_processed: 10, uptime_s: 100,
    cache: { max_memory_mb: 2048, current_memory_mb: 1024.5, entry_count: 4 }, ...status } });
test('vllm-mlx: a decoding request, a queue, concurrency and a registry', async () => {
  const decode = await serve(link('vllm', 'vllm-mlx'), [vllm({}), vllm({ requests: [vllmRequest({ completion_tokens: 125 })] })], { polls: 2 });
  decode.forEach((result, index) => expectRoundTrip(`vllm decode #${index}`, result));
  expect(decode[1]!.body.runtime.request).toMatchObject({ decodeTps: 50, outputTokens: 125, cachedTokens: 500, promptTokens: 1000, elapsedMs: 3000 });
  expect(decode[1]!.body.runtime.server.cache).toEqual({ ramBytes: Math.round(1024.5 * 1024 ** 2), ramEntries: 4 });
  for (const [name, status] of [['queued', { num_running: 0, num_waiting: 2, requests: [] }],
    ['concurrent', { num_running: 2, requests: [vllmRequest(), vllmRequest({ request_id: 'fixture-second' })] }],
    ['registry', { model_manager: { models: [{ id: '/models/example-a', loaded: true }, { id: 'example-b', loaded: false }] } }]] as const) {
    const [result] = await serve(link('vllm', 'vllm-mlx'), vllm(status));
    expectRoundTrip(`vllm ${name}`, result!);
  }
});

const splash = (overrides: Record<string, unknown> = {}) => ({ '/status': { ready: true, maximum_context_tokens: 262_144,
  instance: { model: 'example/Example-27B-Splash', pid: 4242 }, requests: { submitted: 18, completed: 17, cancelled: 1, failed: 0 },
  metrics: { decode_tokens_per_second: 47.2 }, memory_actual: { current_bytes: 12_500_000_000, peak_bytes: 13_000_000_000 }, ...overrides } });
test('Splash: idle, busy and loading, with Metal memory as the runtime reported it', async () => {
  const [idle] = await serve(link('splash', 'splash'), splash());
  expect(expectRoundTrip('Splash idle', idle!).runtime).toMatchObject({ phase: 'idle', memory: { metalBytes: 12_500_000_000, metalPeakBytes: 13_000_000_000 },
    server: { active: 0, averages: { decodeTps: 47.2, requestsTotal: 17, failedTotal: 0 } } });
  expect(idle!.body.capabilities['server.requests']?.basis).toBe('derived');
  const [busy] = await serve(link('splash', 'splash'), splash({ requests: { submitted: 21, completed: 17, cancelled: 1, failed: 1 } }));
  expect(expectRoundTrip('Splash busy', busy!).runtime).toMatchObject({ phase: 'processing', server: { active: 2 } });
  const [loading] = await serve(link('splash', 'splash'), splash({ ready: false }));
  expect(expectRoundTrip('Splash loading', loading!).status).toEqual({ state: 'degraded', reason: 'loading', params: {} });
  const [detected] = await serve(link('local', null), { '/health': 404, '/api/v1/models': 404, ...splash() });
  expect(expectRoundTrip('Splash detected', detected!).connection.detection).toEqual({ basis: 'probe', confidence: 'medium', probe: '/status' });
  expect(JSON.stringify([idle, busy, loading].map(result => result!.body))).not.toContain('4242');
});

test('an unsupported endpoint and an unreachable runtime keep their 1.6 wording in the bridge', async () => {
  const [unsupported] = await serve(link('custom', null), { '/health': 404, '/api/v1/models': 404, '/status': 404, '/v1/models': { data: [] } });
  expect(expectRoundTrip('unsupported', unsupported!).status).toEqual({ state: 'failing', reason: 'unsupported_contract', params: {} });
  expect(unsupported!.body.connection.detection).toEqual({ basis: 'probe', confidence: 'low' });
  const [down] = await serve(link('omlx', 'omlx'), { '/health': 500 });
  expect(expectRoundTrip('unreachable', down!).compat?.connection?.diagnostic).toBe('offline');
});
