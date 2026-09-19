import { expect, test } from 'bun:test';
import { VllmMlxClient } from './vllm-mlx.ts';

type Value = Record<string, unknown>;
const request = (overrides: Value = {}): Value => ({ request_id: 'private-request-a', status: 'running', phase: 'generation',
  prompt_tokens: 1000, completion_tokens: 100, max_tokens: 4096, progress: 0.024, tokens_per_second: 50,
  elapsed_s: 3, ttft_s: 1, cached_tokens: 500, cache_hit_type: 'prefix', ...overrides });
const fixture = (engine = 'batched', modelType = 'llm') => {
  let now = 100_000;
  const health: Value = { status: 'healthy', model_loaded: true, model_name: 'example-model', engine_type: engine, model_type: modelType };
  const status: Value = { status: 'running', model: 'example-model', num_running: 1, num_waiting: 0,
    requests: [request()], total_requests_processed: 10, total_prompt_tokens: 10_000, total_completion_tokens: 2_000,
    uptime_s: 100, generation_tps: 999, prompt_tps: 999,
    metal: { active_memory_gb: 4, peak_memory_gb: 8, cache_memory_gb: 1 } };
  const paths: string[] = [];
  let failure: Error | null = null;
  const client = new VllmMlxClient(async path => {
    paths.push(path);
    if (failure) throw failure;
    return structuredClone(path === '/health' ? health : status);
  }, () => now);
  return { client, status, health, paths, advance: (ms = 500) => { now += ms; },
    setRequests: (...items: Value[]) => { status.requests = items; }, fail: (error: Error | null) => { failure = error; } };
};

test('vllm-mlx requires observed advancement before live speed and expires stalled output', async () => {
  const f = fixture();
  const first = await f.client.snapshot();
  expect(first).toMatchObject({ available: true, phase: 'processing', liveDecodeTPS: null, completionTokens: 100 });
  f.advance(); f.setRequests(request({ completion_tokens: 125 }));
  const live = await f.client.snapshot();
  expect(live).toMatchObject({ phase: 'decode', liveDecodeTPS: 50, promptTokens: 1000, cachedTokens: 500,
    sessionAverageDecodeTPS: null, sessionAveragePrefillTPS: null, memory: null });
  expect(live.traceEpoch).toBe(first.traceEpoch);
  expect(JSON.stringify(live)).not.toContain('private-request');
  f.advance(5000);
  expect((await f.client.snapshot()).phase).toBe('decode');
  f.advance(1);
  expect(await f.client.snapshot()).toMatchObject({ phase: 'processing', liveDecodeTPS: null, completionTokens: 125 });
});

test('vllm-mlx resets continuity on request, phase, counter reset and monitoring gaps', async () => {
  const f = fixture();
  await f.client.snapshot(); f.advance(); f.setRequests(request({ completion_tokens: 125 }));
  let last = await f.client.snapshot();
  for (const next of [request({ request_id: 'private-request-b', completion_tokens: 200 }),
    request({ request_id: 'private-request-b', completion_tokens: 2 }),
    request({ request_id: 'private-request-b', phase: 'prefill', completion_tokens: 0 }),
    request({ request_id: 'private-request-b', completion_tokens: 20 })]) {
    f.advance(); f.setRequests(next);
    const current = await f.client.snapshot();
    expect(current.traceEpoch).not.toBe(last.traceEpoch); expect(current.liveDecodeTPS).toBeNull(); last = current;
  }
  f.advance(11_000); f.setRequests(request({ request_id: 'private-request-b', completion_tokens: 200 }));
  const restored = await f.client.snapshot();
  expect(restored.phase).toBe('processing'); expect(restored.traceEpoch).not.toBe(last.traceEpoch);
});

test('vllm-mlx cannot prove recent output when the sampling gap exceeds its freshness window', async () => {
  const f = fixture();
  await f.client.snapshot(); f.advance(); f.setRequests(request({ completion_tokens: 125 }));
  await f.client.snapshot();
  f.advance(5001); f.setRequests(request({ completion_tokens: 150 }));
  expect(await f.client.snapshot()).toMatchObject({ phase: 'processing', liveDecodeTPS: null });
});

test('vllm-mlx never calls output-budget progress prefill progress', async () => {
  for (const engine of ['simple', 'batched']) {
    const f = fixture(engine);
    f.setRequests(request({ phase: 'prefill', completion_tokens: 0, progress: 0.64 }));
    expect(await f.client.snapshot()).toMatchObject({ phase: 'prefill', prefillProgress: null,
      prefillProcessedTokens: null, prefillTotalTokens: null, prefillETASeconds: null, livePrefillTPS: null });
  }
});

test('vllm-mlx batched MLLM ratios are reported without fabricated counts or ETA and become stale', async () => {
  const f = fixture('batched', 'mllm');
  f.setRequests(request({ phase: 'prefill', completion_tokens: 0, progress: 0.64, cached_tokens: 0, cache_hit_type: null }));
  expect(await f.client.snapshot()).toMatchObject({ phase: 'prefill', prefillProgress: 0.64,
    cachedTokens: null, prefillProgressStale: true, prefillProcessedTokens: null, prefillTotalTokens: null, prefillETASeconds: null });
  f.advance(); f.setRequests(request({ phase: 'prefill', completion_tokens: 0, progress: 0.65 }));
  expect((await f.client.snapshot()).prefillProgressStale).toBe(false);
  for (let i = 0; i < 30; i++) { f.advance(); await f.client.snapshot(); }
  expect((await f.client.snapshot()).prefillProgressStale).toBe(true);
  f.advance(); f.setRequests(request({ phase: 'prefill', completion_tokens: 0, progress: 0.7 }));
  expect(await f.client.snapshot()).toMatchObject({ prefillProgress: 0.7, prefillProgressStale: false });
  for (const progress of [0, 1, 1.01, -1, NaN]) {
    f.advance(); f.setRequests(request({ phase: 'prefill', completion_tokens: 0, progress }));
    expect((await f.client.snapshot()).prefillProgress).toBeNull();
  }
});

test('vllm-mlx prefill never restores an old percentage as fresh after a pause or reconnect', async () => {
  const f = fixture('batched', 'mllm');
  f.setRequests(request({ phase: 'prefill', completion_tokens: 0, progress: 0.4 }));
  await f.client.snapshot(); f.advance();
  f.setRequests(request({ phase: 'prefill', completion_tokens: 0, progress: 0.5 }));
  expect((await f.client.snapshot()).prefillProgressStale).toBe(false);
  f.advance(11_000);
  const restored = await f.client.snapshot();
  expect(restored).toMatchObject({ prefillProgress: 0.5, prefillProgressStale: true });
  f.advance(); f.setRequests(request({ phase: 'prefill', completion_tokens: 0, progress: 0.6 }));
  expect((await f.client.snapshot()).prefillProgressStale).toBe(false);
  f.fail(new Error('connection lost'));
  await expect(f.client.snapshot()).rejects.toThrow('connection lost');
  f.fail(null); f.advance();
  expect(await f.client.snapshot()).toMatchObject({ prefillProgress: 0.6, prefillProgressStale: true });
});

test('vllm-mlx invalid output counters break the proof of recent advancement', async () => {
  const f = fixture();
  await f.client.snapshot(); f.advance(); f.setRequests(request({ completion_tokens: 125 }));
  expect((await f.client.snapshot()).phase).toBe('decode');
  f.advance(); f.setRequests(request({ completion_tokens: null })); await f.client.snapshot();
  f.advance(); f.setRequests(request({ completion_tokens: 125 }));
  expect(await f.client.snapshot()).toMatchObject({ phase: 'processing', liveDecodeTPS: null });
});

test('vllm-mlx filters SimpleEngine worker bookkeeping and placeholder reuse', async () => {
  const f = fixture('simple');
  const worker = { request_id: 'private-worker', status: 'running', kind: 'stream_generate', completion_tokens: 100 };
  f.setRequests(request({ cached_tokens: 0, cache_hit_type: null }), worker);
  await f.client.snapshot(); f.advance();
  f.setRequests(request({ completion_tokens: 125, cached_tokens: 0, cache_hit_type: null }), worker);
  expect(await f.client.snapshot()).toMatchObject({ phase: 'decode', liveDecodeTPS: 50, cachedTokens: null, activeRequests: 1 });
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
    expect(await f.client.snapshot()).toMatchObject({ phase: 'processing', traceEpoch: null, promptTokens: null,
      cachedTokens: null, completionTokens: null, liveDecodeTPS: null });
  }
});

test('vllm-mlx rejects incomplete status contracts and inconsistent prefill counters', async () => {
  for (const body of [{ status: 'running' }, { status: 'running', model_manager: {} },
    { status: 'running', model: 'example-model', requests: null }]) {
    const client = new VllmMlxClient(async () => body);
    expect(await client.snapshot()).toMatchObject({ available: false, reason: 'unsupported_contract' });
  }
  const f = fixture('batched', 'mllm');
  f.setRequests(request({ phase: 'prefill', completion_tokens: 100, progress: 0.5 }));
  expect((await f.client.snapshot()).prefillProgress).toBeNull();
});

test('vllm-mlx retains queue counts beside one active request and does not mix queued metadata', async () => {
  const f = fixture(); f.status.num_waiting = 2;
  const queued = request({ request_id: 'private-queued', status: 'waiting', phase: 'queued', prompt_tokens: 5000 });
  f.setRequests(request(), queued);
  await f.client.snapshot(); f.advance(); f.setRequests(request({ completion_tokens: 125 }), queued);
  expect(await f.client.snapshot()).toMatchObject({ phase: 'decode', activeRequests: 1, queuedRequests: 2, promptTokens: 1000 });
});

test('vllm-mlx distinguishes empty, idle, queued, loading and stopped engines', async () => {
  const f = fixture(); f.setRequests(); f.status.num_running = 0;
  expect((await f.client.snapshot()).phase).toBe('idle');
  f.status.num_waiting = 1; expect((await f.client.snapshot()).phase).toBe('queued');
  f.status.status = 'not_loaded'; expect((await f.client.snapshot()).phase).toBe('notLoaded');
  f.status.residency = { state: 'loading' }; expect((await f.client.snapshot()).phase).toBe('processing');
  f.status.status = 'stopped'; expect((await f.client.snapshot()).phase).toBe('unknown');
});

test('vllm-mlx registry data exposes bounded residency without private paths or estimated process memory', async () => {
  const f = fixture();
  f.status.model_manager = { memory_budget_gb: 24, models: [{ id: '/private/models/local-model', loaded: true,
    source: '/private/weights', memory_gb: 12 }, ...Array.from({ length: 20 }, (_, n) => ({ id: `model-${n}`, loaded: false }))] };
  const result = await f.client.snapshot();
  expect(result.catalog).toHaveLength(12);
  expect(result.catalog![0]).toMatchObject({ name: 'local-model', loaded: true, contextWindow: null });
  expect(result).toMatchObject({ phase: 'unknown', activeRequests: null, memory: null, traceEpoch: null, completionTokens: null });
  expect(JSON.stringify(result)).not.toContain('/private');
});

test('vllm-mlx keeps placeholder and malformed counts unavailable', async () => {
  const f = fixture('simple'); f.setRequests(request({ phase: 'prefill', prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0.5 }));
  f.status.total_prompt_tokens = 0.5;
  expect(await f.client.snapshot()).toMatchObject({ promptTokens: null, cachedTokens: null, completionTokens: null,
    lifetime: { promptTokensTotal: null }, sessionAverageDecodeTPS: null, sessionAveragePrefillTPS: null });
});

test('vllm-mlx cache memory uses the reported binary MB contract and ignores disabled placeholders', async () => {
  const f = fixture(); f.status.cache = { max_memory_mb: 2048, current_memory_mb: 1024, entry_count: 4, hits: 5, misses: 5 };
  expect(await f.client.snapshot()).toMatchObject({ sessionBank: { hot: { totalGB: 1.073741824, entries: 4 } }, sessionCacheEfficiencyPercent: null });
  f.status.cache = { max_memory_mb: 0, current_memory_mb: 0, entry_count: 0 };
  expect((await f.client.snapshot()).sessionBank).toBeNull();
});

test('vllm-mlx demand-caches health metadata and refreshes on model changes', async () => {
  const f = fixture(); await f.client.snapshot();
  f.advance(); await f.client.snapshot();
  expect(f.paths.filter(path => path === '/health')).toHaveLength(1);
  f.status.model = 'other-model'; f.health.model_name = 'other-model';
  await f.client.snapshot(); expect(f.paths.filter(path => path === '/health')).toHaveLength(2);
  expect(new Set(f.paths)).toEqual(new Set(['/health', '/v1/status']));
});

test('vllm-mlx bounds health retries when metadata is incomplete or does not match the status model', async () => {
  const f = fixture('batched', 'mllm');
  f.health.model_name = 'different-model';
  f.setRequests(request({ phase: 'prefill', progress: 0.5 }));
  expect((await f.client.snapshot()).prefillProgress).toBeNull();
  f.advance(); await f.client.snapshot();
  expect(f.paths.filter(path => path === '/health')).toHaveLength(1);
  f.advance(60_000); await f.client.snapshot();
  expect(f.paths.filter(path => path === '/health')).toHaveLength(2);
});

test('vllm-mlx preserves broker failures and resets output continuity after reconnect', async () => {
  const f = fixture(); await f.client.snapshot(); f.advance(); f.setRequests(request({ completion_tokens: 125 }));
  const live = await f.client.snapshot();
  const failure = new Error('broker rejected credential'); f.fail(failure);
  await expect(f.client.snapshot()).rejects.toBe(failure);
  f.fail(null); f.advance(); f.setRequests(request({ completion_tokens: 150 }));
  const restored = await f.client.snapshot();
  expect(restored.phase).toBe('processing'); expect(restored.traceEpoch).not.toBe(live.traceEpoch);
  expect(restored.liveDecodeTPS).toBeNull();
});
