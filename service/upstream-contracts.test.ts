import { expect, test } from 'bun:test';
import { OmlxClient } from './omlx-client.ts';
import { resolveOmlxConfig } from './config.ts';

const readConfig = () => resolveOmlxConfig({
  home: '/unused', env: { MLX_SCOPE_BASE_URL: 'http://127.0.0.1:8000' }, readText: async () => null,
});

test('samples live activity without repeating expensive session-cache reads within ten seconds', async () => {
  let now = 100_000, activityReads = 0, statsReads = 0;
  const client = new OmlxClient({ readConfig, now: () => now, fetchImpl: async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/health') return Response.json({ status: 'healthy', engine_pool: { model_count: 0 } });
    if (path === '/v1/models/status') return Response.json({ models: [] });
    if (path === '/admin/api/stats') statsReads++;
    if (path === '/admin/api/activity') activityReads++;
    return Response.json({ engines: {}, active_models: { models: [] } });
  } });
  await client.snapshot();
  for (let index = 0; index < 19; index++) { now += 500; await client.snapshot(); }
  expect(activityReads).toBe(20);
  expect(statsReads).toBe(1);
  now += 500;
  await client.snapshot();
  expect(activityReads).toBe(21);
  expect(statsReads).toBe(2);
});

test('reads model-loading activity while oMLX startup health reports 503/loading', async () => {
  const paths: string[] = [];
  const client = new OmlxClient({ readConfig, fetchImpl: async (url) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path === '/health') return Response.json({ status: 'loading', engine_pool: { model_count: 1 } }, { status: 503 });
    if (path === '/v1/models/status') return Response.json({ models: [] });
    return Response.json({ engines: {}, active_models: { models: [{
      id: 'example-model', is_loading: true, actual_size: 0, active_requests: 0, waiting_requests: 0,
      prefilling: [], generating: [], activities: [], loading_elapsed_seconds: 12,
    }] } });
  } });
  const result = await client.snapshot();
  expect(result).toMatchObject({ available: true, phase: 'processing', memory: { modelGB: null } });
  expect(result.message).toContain('Loading the model');
  expect(result.residentModels[0]?.allocationGB).toBeNull();
  expect(paths).toContain('/admin/api/activity');
});

test('rejects unrelated 503 health responses before authentication or activity', async () => {
  for (const body of [
    { status: 'loading' },
    { status: 'healthy', engine_pool: { model_count: 1 } },
    { status: 'loading', engine_pool: { model_count: -1 } },
    { status: 'loading', engine_pool: { model_count: 0.5 } },
  ]) {
    const paths: string[] = [];
    const client = new OmlxClient({ readConfig, fetchImpl: async (url) => {
      paths.push(new URL(String(url)).pathname);
      return Response.json(body, { status: 503 });
    } });
    expect((await client.snapshot()).available).toBe(false);
    expect(paths).toEqual(['/health']);
  }
});

test('loading health does not make a failing activity endpoint look connected', async () => {
  const client = new OmlxClient({ readConfig, fetchImpl: async (url) => {
    if (new URL(String(url)).pathname === '/health') {
      return Response.json({ status: 'loading', engine_pool: { model_count: 1 } }, { status: 503 });
    }
    return Response.json({ status: 'loading' }, { status: 503 });
  } });
  expect(await client.snapshot()).toMatchObject({ available: false, reason: 'runtime_unreachable' });
});

test('withholds observation continuity for missing and synthetic distributed request identities', async () => {
  for (const kind of ['prefilling', 'generating', 'activities'] as const) {
    for (const request_id of [undefined, '', '   ']) {
      const client = new OmlxClient({ readConfig, fetchImpl: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === '/health') return Response.json({ status: 'healthy', engine_pool: { model_count: 1 } });
        if (path === '/v1/models/status') return Response.json({ models: [] });
        return Response.json({ engines: {}, active_models: { models: [{
          id: 'example-model', active_requests: 1, waiting_requests: 0,
          [kind]: [{ request_id, kind: 'generate', generated_tokens: 60, token_count: 60,
            elapsed_seconds: 3, last_activity_age_seconds: 0.1, tokens_per_second: 20,
            processed: 60, total: 100, speed: 20 }],
        }] } });
      } });
      expect((await client.snapshot()).traceEpoch).toBeNull();
    }
  }
  const client = new OmlxClient({ readConfig, fetchImpl: async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/health') return Response.json({ status: 'healthy', engine_pool: { model_count: 1 } });
    if (path === '/v1/models/status') return Response.json({ models: [] });
    return Response.json({ engines: {}, active_models: { models: [{
      id: 'example-model', cluster: { live: { stale: false } }, active_requests: 1, waiting_requests: 0,
      generating: [{ request_id: 'rank0', generated_tokens: 60, elapsed_seconds: 3,
        last_activity_age_seconds: 0.1, tokens_per_second: 20, prompt_tokens: 100 }],
    }] } });
  } });
  expect(await client.snapshot()).toMatchObject({ available: true, phase: 'processing', activeRequests: 1,
    traceEpoch: null, promptTokens: null, completionTokens: null, liveDecodeTPS: null });
});
