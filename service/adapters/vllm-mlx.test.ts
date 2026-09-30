import { expect, test } from 'bun:test';
import { HttpFailure } from '../http.ts';
import { READ, routeContext, type Route } from './testing.ts';
import { vllmMlxDescriptor } from './vllm-mlx.ts';

type Value = Record<string, unknown>;
const request = (overrides: Value = {}): Value => ({ request_id: 'private-request-a', status: 'running', phase: 'generation',
  prompt_tokens: 1000, completion_tokens: 100, max_tokens: 4096, progress: 0.024, tokens_per_second: 50,
  elapsed_s: 3, ttft_s: 1, cached_tokens: 500, cache_hit_type: 'prefix', ...overrides });
const fixture = (engine = 'batched', modelType = 'llm') => {
  const clock = { now: 100_000 };
  const health: Value = { status: 'healthy', model_loaded: true, model_name: 'example-model', engine_type: engine, model_type: modelType, available_models: ['example-model'] };
  const status: Value = { status: 'running', model: 'example-model', num_running: 1, num_waiting: 0,
    requests: [request()], total_requests_processed: 10, total_prompt_tokens: 10_000, total_completion_tokens: 2_000,
    uptime_s: 100, generation_tps: 999, prompt_tps: 999, metal: { active_memory_gb: 4, peak_memory_gb: 8, cache_memory_gb: 1 } };
  const overrides: Record<string, Route> = {};
  const { context, paths } = routeContext(() => ({ '/health': health, '/v1/status': status, ...overrides }), clock);
  const adapter = vllmMlxDescriptor.create(context);
  return { adapter, status, health, paths, overrides, read: () => adapter.read(READ), advance: (ms = 500) => { clock.now += ms; },
    setRequests: (...items: Value[]) => { status.requests = items; } };
};

test('vllm-mlx requires observed advancement before live speed and expires stalled output', async () => {
  const f = fixture();
  const first = await f.read();
  expect(first.status).toEqual({ state: 'ready', reason: null, params: {} });
  expect(first.runtime).toMatchObject({ phase: 'processing', request: { model: 'example-model', outputTokens: 100 } });
  expect(first.runtime.request?.decodeTps).toBeUndefined();
  f.advance(); f.setRequests(request({ completion_tokens: 125 }));
  const live = await f.read();
  expect(live.runtime).toMatchObject({ phase: 'decode', request: { decodeTps: 50, promptTokens: 1000, cachedTokens: 500, outputTokens: 125, elapsedMs: 3_000 },
    server: { active: 1, queued: 0, averages: { requestsTotal: 10, uptimeMs: 100_000 } }, memory: {} });
  expect(live.runtime.server.averages?.decodeTps).toBeUndefined();
  expect(JSON.stringify(live)).not.toContain('private-request');
  f.advance(5000);
  expect((await f.read()).runtime.phase).toBe('decode');
  f.advance(1);
  const stalled = await f.read();
  expect([stalled.runtime.phase, stalled.runtime.request?.decodeTps, stalled.runtime.request?.outputTokens]).toEqual(['processing', undefined, 125]);
});

test('vllm-mlx restarts the proof of advancement on a new request, phase, counter reset, monitoring gap or dropped read', async () => {
  const f = fixture();
  await f.read(); f.advance(); f.setRequests(request({ completion_tokens: 125 }));
  expect((await f.read()).runtime.phase).toBe('decode');
  for (const next of [request({ request_id: 'private-request-b', completion_tokens: 200 }), request({ request_id: 'private-request-b', completion_tokens: 2 }),
    request({ request_id: 'private-request-b', phase: 'prefill', completion_tokens: 0 }), request({ request_id: 'private-request-b', completion_tokens: 20 })]) {
    f.advance(); f.setRequests(next);
    expect((await f.read()).runtime.request?.decodeTps).toBeUndefined();
  }
  f.advance(); f.setRequests(request({ request_id: 'private-request-b', completion_tokens: 40 }));
  expect((await f.read()).runtime.phase).toBe('decode');
  f.advance(5_001); f.setRequests(request({ request_id: 'private-request-b', completion_tokens: 200 }));
  expect((await f.read()).runtime.phase).toBe('processing');
  f.advance(); f.setRequests(request({ request_id: 'private-request-b', completion_tokens: 220 }));
  expect((await f.read()).runtime.phase).toBe('decode');
  f.overrides['/v1/status'] = new HttpFailure('runtime_unreachable', 'connection lost');
  await expect(f.read()).rejects.toThrow('connection lost');
  delete f.overrides['/v1/status']; f.advance(); f.setRequests(request({ request_id: 'private-request-b', completion_tokens: 240 }));
  expect((await f.read()).runtime.phase).toBe('processing');
});

test('vllm-mlx never calls output-budget progress prefill progress', async () => {
  for (const engine of ['simple', 'batched']) {
    const f = fixture(engine);
    f.setRequests(request({ phase: 'prefill', completion_tokens: 0, progress: 0.64 }));
    const reading = await f.read();
    expect(reading.runtime.phase).toBe('prefill');
    expect(reading.runtime.request?.prefillFraction).toBeUndefined();
    expect(reading.capabilities['request.prefillProgress']).toBeUndefined();
  }
});

test('vllm-mlx batched MLLM ratios are reported without fabricated counts or ETA, and go stale', async () => {
  const f = fixture('batched', 'mllm');
  f.setRequests(request({ phase: 'prefill', completion_tokens: 0, progress: 0.64, cached_tokens: 0, cache_hit_type: null }));
  const first = await f.read();
  expect(first.runtime.request).toEqual({ model: 'example-model', promptTokens: 1000, outputTokens: 0, elapsedMs: 3_000, prefillFraction: 0.64, prefillStale: true });
  expect(first.capabilities['request.prefillProgress']).toEqual({ scope: 'request', basis: 'reported' });
  f.advance(); f.setRequests(request({ phase: 'prefill', completion_tokens: 0, progress: 0.65 }));
  expect((await f.read()).runtime.request?.prefillStale).toBeUndefined();
  for (let i = 0; i < 30; i++) { f.advance(); await f.read(); }
  expect((await f.read()).runtime.request?.prefillStale).toBe(true);
  f.advance(); f.setRequests(request({ phase: 'prefill', completion_tokens: 0, progress: 0.7 }));
  expect((await f.read()).runtime.request).toMatchObject({ prefillFraction: 0.7 });
  for (const progress of [0, 1, 1.01, -1, NaN]) {
    f.advance(); f.setRequests(request({ phase: 'prefill', completion_tokens: 0, progress }));
    expect((await f.read()).runtime.request?.prefillFraction).toBeUndefined();
  }
  f.setRequests(request({ phase: 'prefill', completion_tokens: 100, progress: 0.5 }));
  expect((await f.read()).runtime.request?.prefillFraction).toBeUndefined();
});

test('an optional /health that fails or does not match narrows capabilities instead of blanking the runtime', async () => {
  for (const broken of [new HttpFailure('runtime_unreachable', 'down'), 404, 500, { status: 'healthy' }] as Route[]) {
    const f = fixture('batched', 'mllm');
    f.overrides['/health'] = broken;
    f.setRequests(request({ phase: 'prefill', completion_tokens: 0, progress: 0.5, cache_hit_type: 'prefix', cached_tokens: 400 }));
    const reading = await f.read();
    expect(reading.status.state, String(broken)).toBe('ready');
    expect(reading.runtime.phase).toBe('prefill');
    expect(reading.runtime.request).toMatchObject({ promptTokens: 1000 });
    expect([reading.runtime.request?.prefillFraction, reading.runtime.request?.cachedTokens]).toEqual([undefined, undefined]);
    expect(Object.keys(reading.capabilities).sort()).toEqual(['request.decodeRate', 'request.elapsed', 'request.tokens', 'server.averages', 'server.catalog', 'server.requests']);
    // A failed metadata read is retried with the next minute, not on every poll.
    f.advance(); await f.read(); f.advance(60_000); await f.read();
    expect(f.paths.filter(path => path === '/health')).toHaveLength(2);
  }
});

test('vllm-mlx filters SimpleEngine worker bookkeeping and placeholder reuse', async () => {
  const f = fixture('simple');
  const worker = { request_id: 'private-worker', status: 'running', kind: 'stream_generate', completion_tokens: 100 };
  f.setRequests(request({ cached_tokens: 0, cache_hit_type: null }), worker);
  await f.read(); f.advance();
  f.setRequests(request({ completion_tokens: 125, cached_tokens: 0, cache_hit_type: null }), worker);
  const reading = await f.read();
  expect(reading.runtime).toMatchObject({ phase: 'decode', request: { decodeTps: 50 }, server: { active: 1 } });
  expect(reading.runtime.request?.cachedTokens).toBeUndefined();
});

test('vllm-mlx withholds ambiguous, malformed and excessive per-request detail', async () => {
  for (const setup of [
    (f: ReturnType<typeof fixture>) => { f.status.num_running = 2; f.setRequests(request(), request({ request_id: 'second' })); },
    (f: ReturnType<typeof fixture>) => { f.setRequests(request({ request_id: '' })); },
    (f: ReturnType<typeof fixture>) => { f.status.num_running = 0.5; },
    (f: ReturnType<typeof fixture>) => { f.status.model = null; },
    (f: ReturnType<typeof fixture>) => { f.setRequests(...Array.from({ length: 257 }, () => request())); },
  ]) {
    const f = fixture(); setup(f);
    const reading = await f.read();
    expect(reading.runtime.phase).toBe('processing');
    expect(reading.runtime.request).toBeNull();
  }
});

test('vllm-mlx names an incomplete status contract, a missing route, a rejected key and a server error differently', async () => {
  for (const body of [{ status: 'running' }, { status: 'running', model_manager: {} }, { status: 'running', model: 'example-model', requests: null }, { status: 'busy', model: 'x', requests: [] }]) {
    const f = fixture(); f.overrides['/v1/status'] = body;
    const reading = await f.read();
    expect([reading.status, reading.capabilities, reading.runtime.phase]).toEqual([{ state: 'degraded', reason: 'unsupported_contract', params: {} }, {}, 'unknown']);
  }
  for (const [route, status] of [[404, { state: 'degraded', reason: 'unsupported_contract', params: {} }], [{ status: 200, body: { error: 'Unexpected endpoint or method.' }, routeMissing: true },
    { state: 'degraded', reason: 'unsupported_contract', params: {} }], [401, { state: 'failing', reason: 'authentication_failed', params: {} }]] as const) {
    const f = fixture(); f.overrides['/v1/status'] = route;
    expect((await f.read()).status).toEqual(status);
  }
  const f = fixture(); f.overrides['/v1/status'] = 500;
  await expect(f.read()).rejects.toMatchObject({ reason: 'runtime_unreachable', status: 500 });
});

test('vllm-mlx retains queue counts beside one active request and does not mix queued metadata', async () => {
  const f = fixture(); f.status.num_waiting = 2;
  const queued = request({ request_id: 'private-queued', status: 'waiting', phase: 'queued', prompt_tokens: 5000 });
  f.setRequests(request(), queued);
  await f.read(); f.advance(); f.setRequests(request({ completion_tokens: 125 }), queued);
  expect((await f.read()).runtime).toMatchObject({ phase: 'decode', server: { active: 1, queued: 2 }, request: { promptTokens: 1000 } });
});

test('vllm-mlx distinguishes empty, idle, queued, loading, not-loaded and stopped engines', async () => {
  const f = fixture(); f.setRequests(); f.status.num_running = 0;
  expect((await f.read()).runtime.phase).toBe('idle');
  f.status.num_waiting = 1; expect((await f.read()).runtime.phase).toBe('queued');
  f.status.status = 'not_loaded';
  const unloaded = await f.read();
  expect([unloaded.runtime.phase, unloaded.runtime.catalog, Object.keys(unloaded.capabilities)])
    .toEqual(['not-loaded', [{ name: 'example-model', loaded: false, format: 'mlx', contextWindowTokens: null }], ['server.catalog']]);
  f.status.residency = { state: 'loading' }; expect((await f.read()).runtime.phase).toBe('loading');
  f.status.residency = { state: 'unloading' }; expect((await f.read()).runtime.phase).toBe('processing');
  f.status.status = 'stopped';
  expect((await f.read()).runtime).toMatchObject({ phase: 'unknown', server: { active: null, queued: null } });
});

test('vllm-mlx registry data is a bounded catalogue without private paths or estimated process memory', async () => {
  const f = fixture();
  f.status.model_manager = { memory_budget_gb: 24, models: [{ id: '/private/models/local-model', loaded: true,
    source: '/private/weights', memory_gb: 12 }, ...Array.from({ length: 20 }, (_, n) => ({ id: `model-${n}`, loaded: false }))] };
  const reading = await f.read();
  expect(reading.runtime.catalog).toHaveLength(12);
  expect(reading.runtime.catalog[0]).toEqual({ name: 'local-model', loaded: true, format: 'mlx', contextWindowTokens: null });
  expect(reading.runtime).toMatchObject({ phase: 'unknown', request: null, server: { active: null }, memory: {} });
  expect(Object.keys(reading.capabilities)).toEqual(['server.catalog']);
  expect(JSON.stringify(reading)).not.toContain('/private');
  expect(f.paths).not.toContain('/health');
});

test('vllm-mlx keeps placeholder and malformed counts unavailable', async () => {
  const f = fixture('simple'); f.setRequests(request({ phase: 'prefill', prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0.5 }));
  f.status.total_requests_processed = 0.5;
  const reading = await f.read();
  expect(reading.runtime.request).toEqual({ model: 'example-model', elapsedMs: 3_000 });
  expect(reading.runtime.server.averages).toEqual({ uptimeMs: 100_000 });
});

test('vllm-mlx cache memory uses the reported binary MB contract and ignores disabled placeholders', async () => {
  const f = fixture(); f.status.cache = { max_memory_mb: 2048, current_memory_mb: 1024.5, entry_count: 4, hits: 5, misses: 5 };
  const reading = await f.read();
  expect(reading.runtime.server.cache).toEqual({ ramBytes: Math.round(1024.5 * 1024 ** 2), ramEntries: 4 });
  expect(reading.capabilities['server.cache']).toBeDefined();
  f.status.cache = { max_memory_mb: 0, current_memory_mb: 0, entry_count: 0 };
  const disabled = await f.read();
  expect([disabled.runtime.server.cache, disabled.capabilities['server.cache']]).toEqual([undefined, undefined]);
});

test('vllm-mlx demand-caches health metadata and refreshes it on model changes', async () => {
  const f = fixture(); await f.read();
  f.advance(); await f.read();
  expect(f.paths.filter(path => path === '/health')).toHaveLength(1);
  f.status.model = 'other-model'; f.health.model_name = 'other-model';
  await f.read(); expect(f.paths.filter(path => path === '/health')).toHaveLength(2);
  expect(new Set(f.paths)).toEqual(new Set(['/health', '/v1/status']));
});

test('identity is the status contract itself; detection is by /health shape or an all-vllm-mlx model list', async () => {
  const f = fixture();
  expect(await f.adapter.identity()).toBe(true);
  f.overrides['/v1/status'] = { ready: true };
  expect(await f.adapter.identity()).toBe(false);
  f.overrides['/v1/status'] = 404;
  expect(await f.adapter.identity()).toBe(false);
  const [health, models] = vllmMlxDescriptor.detect;
  const reply = (status: number, body: Value | null) => ({ status, body, routeMissing: false });
  const shape = { model_loaded: false, engine_type: 'unknown', available_models: [] };
  expect([200, 503, 401].map(status => health!.match(reply(status, shape), async () => reply(404, null)))).toEqual([true, true, false]);
  expect(models!.match(reply(200, { data: [{ owned_by: 'vllm-mlx' }, { owned_by: 'vllm-mlx-reranker' }] }), async () => reply(404, null))).toBe(true);
  expect(models!.match(reply(200, { data: [{ owned_by: 'vllm-mlx' }, { owned_by: 'mlx' }] }), async () => reply(404, null))).toBe(false);
  expect(vllmMlxDescriptor.hints('vllm_mlx', '')).toBe(true);
});
