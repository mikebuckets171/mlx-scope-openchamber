import { expect, test } from 'bun:test';
import { LMStudioClient } from './lmstudio.ts';
import { HttpFailure } from './http.ts';

const model = (extra: Record<string, unknown> = {}) => ({
  type: 'llm', key: 'fixture/model', format: 'mlx', max_context_length: 32768,
  loaded_instances: [{ id: 'fixture/loaded-model', config: { context_length: 8192 } }], ...extra,
});

test('LM Studio inventory preserves configured context and loaded instances without inventing inference', async () => {
  const calls: string[] = [];
  const client = new LMStudioClient(async path => {
    calls.push(path);
    return { models: [
      model({ key: 'fixture/unloaded', loaded_instances: [], format: 'gguf' }),
      model({ size_bytes: 12_000_000_000, loaded_instances: [{ id: 'fixture/loaded-model', config: { context_length: 8192, parallel: 4 } }] }),
      model({ type: 'embedding', key: 'fixture/embedding', loaded_instances: [], format: null }),
    ] };
  }, () => 1234);
  const result = await client.snapshot();
  expect(calls).toEqual(['/api/v1/models']);
  expect(result).toMatchObject({ available: true, runtime: 'lmstudio', phase: 'unknown', sampledAt: 1234,
    modelID: 'fixture/loaded-model', residentModelCount: 1, contextWindow: null,
    activeRequests: null, queuedRequests: null, promptTokens: null, completionTokens: null,
    prefillProgress: null, prefillETASeconds: null, liveDecodeTPS: null, memory: null });
  expect(result.catalog).toEqual([
    { name: 'fixture/unloaded', loaded: false, format: 'gguf', contextWindow: 32768 },
    { name: 'fixture/model', loaded: true, format: 'mlx', contextWindow: 8192 },
    { name: 'fixture/embedding', loaded: false, format: null, contextWindow: 32768 },
  ]);
  expect(result.residentModels).toEqual([{ id: 'fixture/loaded-model', phase: 'unknown', activeRequests: null,
    queuedRequests: null, allocationGB: null, tokensPerSecond: null, prefillProgress: null, progressStale: false }]);
});

test('empty LM Studio inventory is connected without an invented idle request', async () => {
  const result = await new LMStudioClient(async () => ({ models: [] })).snapshot();
  expect(result).toMatchObject({ available: true, phase: 'unknown', modelID: null, residentModels: [],
    residentModelCount: 0, catalog: [], activeRequests: null, queuedRequests: null });
});

test('only a typed v1 route 404 enables the documented v0 inventory fallback', async () => {
  const calls: string[] = [];
  const client = new LMStudioClient(async path => {
    calls.push(path);
    if (path === '/api/v1/models') throw new HttpFailure('runtime_unreachable', 'Route unavailable.', 404);
    return { object: 'list', data: [
      { id: 'fixture/legacy-loaded', type: 'vlm', state: 'loaded', compatibility_type: 'mlx', max_context_length: 16384 },
      { id: 'fixture/legacy-unloaded', type: 'llm', state: 'not-loaded', compatibility_type: 'gguf', max_context_length: 32768 },
    ] };
  });
  const result = await client.snapshot();
  await client.snapshot();
  expect(calls).toEqual(['/api/v1/models', '/api/v0/models', '/api/v0/models']);
  expect(result).toMatchObject({ available: true, modelID: 'fixture/legacy-loaded', residentModelCount: 1, phase: 'unknown', contextWindow: null });
  expect(result.catalog?.[0]).toEqual({ name: 'fixture/legacy-loaded', loaded: true, format: 'mlx', contextWindow: 16384 });
});

test('authentication, server and malformed-response failures never try an unauthenticated or legacy fallback', async () => {
  for (const status of [401, 403, 500, 503, null]) {
    const calls: string[] = [];
    const failure = new HttpFailure(status === 401 || status === 403 ? 'authentication_failed' : 'runtime_unreachable', 'Request failed.', status);
    const client = new LMStudioClient(async path => { calls.push(path); throw failure; });
    await expect(client.snapshot()).rejects.toBe(failure);
    expect(calls).toEqual(['/api/v1/models']);
  }
  const spoofed = Object.assign(new Error('Not a typed HTTP response'), { status: 404 });
  await expect(new LMStudioClient(async () => { throw spoofed; }).snapshot()).rejects.toBe(spoofed);
});

test('malformed LM Studio inventory stays unavailable without trying another API', async () => {
  for (const body of [null, {}, { models: null }, { models: {} }, { models: [null, { id: 'wrong-contract' }] }]) {
    const calls: string[] = [];
    const result = await new LMStudioClient(async path => { calls.push(path); return body; }).snapshot();
    expect(result).toMatchObject({ available: false, reason: 'unsupported_contract', runtime: 'lmstudio', residentModelCount: null });
    expect(calls).toEqual(['/api/v1/models']);
  }
});

test('missing loading state and malformed or conflicting contexts remain unknown', async () => {
  const result = await new LMStudioClient(async () => ({ models: [
    model({ key: 'missing/state', loaded_instances: undefined }),
    model({ key: 'invalid/state', loaded_instances: [null] }),
    model({ key: 'different/contexts', loaded_instances: [
      { id: 'first', config: { context_length: 8192 } }, { id: 'second', config: { context_length: 16384 } },
    ] }),
    model({ key: 'invalid/context', loaded_instances: [{ id: 'third', config: { context_length: 8.5 } }] }),
  ] })).snapshot();
  expect(result.residentModelCount).toBeNull();
  expect(result.catalog?.map(item => ({ loaded: item.loaded, context: item.contextWindow }))).toEqual([
    { loaded: null, context: null }, { loaded: null, context: null },
    { loaded: true, context: null }, { loaded: true, context: null },
  ]);
  expect(result.residentModels.map(item => item.id)).toEqual(['first', 'second', 'third']);
});

test('absolute model paths and unrelated server fields never leave the adapter', async () => {
  const paths = ['/private/example/models/mac-model', 'C:\\private\\models\\windows-model', '~/models/home-model', 'file:///private/models/file-model'];
  const result = await new LMStudioClient(async () => ({ models: paths.map(path => model({
    key: path, display_name: '/private/display-name', secret: 'discard-secret', request_id: 'discard-request',
    output: 'discard-output', loaded_instances: [{ id: path, config: { context_length: 8192 }, credential: 'discard-key' }],
  })), credential: 'discard-response-key' })).snapshot();
  expect(result.catalog?.map(item => item.name)).toEqual(['mac-model', 'windows-model', 'home-model', 'file-model']);
  expect(result.residentModels.map(item => item.id)).toEqual(['mac-model', 'windows-model', 'home-model', 'file-model']);
  const encoded = JSON.stringify(result);
  for (const forbidden of ['private', 'discard-', 'credential', 'request_id', 'display_name']) expect(encoded).not.toContain(forbidden);
});

test('catalog and resident display rows are bounded while known instance count remains separate', async () => {
  const result = await new LMStudioClient(async () => ({ models: Array.from({ length: 24 }, (_, index) => model({
    key: `model-${index}`, loaded_instances: [{ id: `instance-${index}`, config: { context_length: 8192 } }],
  })) })).snapshot();
  expect(result.catalog).toHaveLength(12);
  expect(result.residentModels).toHaveLength(12);
  expect(result.residentModelCount).toBe(24);
});

test('legacy model states and malformed legacy inventory do not fabricate loaded models', async () => {
  for (const body of [{ data: [] }, { object: 'list', data: null }]) {
    const client = new LMStudioClient(async path => {
      if (path === '/api/v1/models') throw new HttpFailure('runtime_unreachable', 'Missing route.', 404);
      return body;
    });
    expect((await client.snapshot()).available).toBe(false);
  }
  const result = await new LMStudioClient(async path => {
    if (path === '/api/v1/models') throw new HttpFailure('runtime_unreachable', 'Missing route.', 404);
    return { object: 'list', data: [{ id: 'fixture', type: 'llm', state: 'loading', compatibility_type: 'unknown', max_context_length: -1 }] };
  }).snapshot();
  expect(result).toMatchObject({ available: true, residentModels: [], residentModelCount: null,
    catalog: [{ name: 'fixture', loaded: null, format: null, contextWindow: null }] });
});
