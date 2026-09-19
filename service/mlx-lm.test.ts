import { expect, test } from 'bun:test';
import { MlxLmClient } from './mlx-lm.ts';

test('mlx-lm reports reachability and a bounded catalogue without inventing residency or inference', async () => {
  const client = new MlxLmClient(async path => path === '/health' ? { status: 'ok' } : {
    object: 'list', data: [{ id: '/private/models/local-model' }, { id: 'mlx-community/example', context: 65536 },
      ...Array.from({ length: 20 }, (_, n) => ({ id: `model-${n}` }))],
  });
  const result = await client.snapshot();
  expect(result).toMatchObject({ available: true, runtime: 'mlx-lm', phase: 'unknown', modelID: null,
    activeRequests: null, queuedRequests: null, liveDecodeTPS: null, prefillProgress: null,
    contextWindow: null, residentModelCount: null, residentModels: [] });
  expect(result.catalog).toHaveLength(12);
  expect(result.catalog![0]).toEqual({ name: 'local-model', loaded: null, format: 'mlx', contextWindow: null });
  expect(JSON.stringify(result)).not.toContain('/private');
});

test('mlx-lm caches expensive catalogue scans for a minute and refreshes on demand', async () => {
  let now = 1_000, reads = 0;
  const paths: string[] = [];
  const client = new MlxLmClient(async path => {
    paths.push(path);
    if (path === '/health') return { status: 'ok' };
    reads++; return { object: 'list', data: [{ id: `model-${reads}` }] };
  }, () => now);
  const first = await client.snapshot();
  first.catalog![0]!.name = 'mutated outside client';
  now += 59_999;
  expect((await client.snapshot()).catalog![0]!.name).toBe('model-1');
  expect(reads).toBe(1);
  now++;
  expect((await client.snapshot()).catalog![0]!.name).toBe('model-2');
  expect(reads).toBe(2);
  expect(new Set(paths)).toEqual(new Set(['/health', '/v1/models']));
});

test('mlx-lm empty or unavailable catalogue does not claim no model is loaded', async () => {
  for (const response of [null, {}, { object: 'list', data: [] }]) {
    const client = new MlxLmClient(async path => path === '/health' ? { status: 'ok' } : response);
    expect(await client.snapshot()).toMatchObject({ available: true, phase: 'unknown', catalog: [], residentModelCount: null });
  }
});

test('mlx-lm unhealthy and unrelated health responses do not trigger a catalogue scan', async () => {
  for (const health of [null, { status: 'unavailable' }, { status: 'healthy' }, {}]) {
    const paths: string[] = [];
    const client = new MlxLmClient(async path => { paths.push(path); return health; });
    expect((await client.snapshot()).available).toBe(false);
    expect(paths).toEqual(['/health']);
  }
});

test('mlx-lm preserves broker failures and never retries anonymously', async () => {
  const failure = new Error('authentication rejected');
  const paths: string[] = [];
  const client = new MlxLmClient(async path => { paths.push(path); throw failure; });
  await expect(client.snapshot()).rejects.toBe(failure);
  expect(paths).toEqual(['/health']);
});

test('mlx-lm cannot hide a rejected catalogue request behind cached anonymous health', async () => {
  const failure = new Error('catalogue access rejected');
  const paths: string[] = [];
  const client = new MlxLmClient(async path => {
    paths.push(path);
    if (path === '/health') return { status: 'ok' };
    throw failure;
  });
  await expect(client.snapshot()).rejects.toBe(failure);
  await expect(client.snapshot()).rejects.toBe(failure);
  expect(paths).toEqual(['/health', '/v1/models', '/health', '/v1/models']);
});
