import { expect, test } from 'bun:test';
import { OmlxClient } from './omlx-client.ts';
import { resolveOmlxConfig } from './config.ts';

test('failed activity does not repeat optional model-status reads within the minute', async () => {
  let now = 100_000, contextReads = 0, port = 8000;
  const client = new OmlxClient({
    now: () => now,
    readConfig: () => resolveOmlxConfig({ home: '/unused', env: { MLX_SCOPE_BASE_URL: `http://127.0.0.1:${port}` }, readText: async () => null }),
    fetchImpl: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/health') return Response.json({status: 'healthy', engine_pool: {model_count: 1}});
      if (path === '/v1/models/status') { contextReads++; return Response.json({models: [{id: 'fixture', max_context_window: 32768}]}); }
      return Response.json({}, {status: 503});
    },
  });
  expect((await client.snapshot()).available).toBe(false);
  now += 10_000;
  expect((await client.snapshot()).available).toBe(false);
  expect(contextReads).toBe(1);
  now += 60_000;
  await client.snapshot();
  expect(contextReads).toBe(2);
  now += 10_000; port = 8123;
  await client.snapshot();
  expect(contextReads).toBe(3);
});

test('missing API credentials are described without claiming a stored key exists', async () => {
  const client = new OmlxClient({
    readConfig: () => resolveOmlxConfig({home: '/unused', env: {MLX_SCOPE_BASE_URL: 'http://127.0.0.1:8000'}, readText: async () => null}),
    fetchImpl: async (url) => new URL(String(url)).pathname === '/health'
      ? Response.json({status:'healthy', engine_pool:{model_count:0}})
      : Response.json({}, {status:401}),
  });
  const result = await client.snapshot();
  expect(result.available).toBe(false);
  expect(result.message).toContain('API key');
  expect(result.message).not.toContain('saved credential');
});
