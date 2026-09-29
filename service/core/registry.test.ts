import { expect, test } from 'bun:test';
import type { Runtime } from '../../src/runtime.ts';
import { unavailableTelemetry, type TelemetrySnapshot } from '../../src/telemetry.ts';
import { HttpFailure, requestJSON, type JsonResponse } from '../http.ts';
import { isOmlxHealth } from '../omlx-client.ts';
import { hintFor } from './hints.ts';
import { cadenceOf, descriptor, DESCRIPTORS, detectRuntime } from './registry.ts';

class UnsupportedRuntime extends Error {}
type Read = (path: string, authenticated?: boolean) => Promise<JsonResponse>;
/** The oracle: service/runtime-client.ts detection as shipped in 1.6.1, verbatim apart from the slot. */
const legacyDetect = async (read: Read): Promise<Runtime> => {
  const slot: { runtime: Runtime | null } = { runtime: null };
  try {
    const health = await read('/health', false);
    if (isOmlxHealth(health.body, health.status)) slot.runtime = 'omlx';
    else if (health.body && typeof health.body.model_loaded === 'boolean' && ['simple', 'batched', 'unknown'].includes(String(health.body.engine_type)) && Array.isArray(health.body.available_models)) slot.runtime = 'vllm-mlx';
  } catch (error) {
    if (!(error instanceof HttpFailure) || ![401, 403, 404].includes(error.status ?? 0)) throw error;
  }
  if (!slot.runtime) {
    try {
      const models = await read('/api/v1/models');
      if (Array.isArray(models.body?.models)) slot.runtime = 'lmstudio';
    } catch (error) { if (!(error instanceof HttpFailure) || error.status !== 404) throw error; }
  }
  if (!slot.runtime) {
    try {
      const status = await read('/status');
      if (typeof status.body?.ready === 'boolean') slot.runtime = 'splash';
    } catch (error) { if (!(error instanceof HttpFailure) || ![404, 405].includes(error.status ?? 0)) throw error; }
  }
  if (!slot.runtime) {
    const response = await read('/v1/models');
    const models = Array.isArray(response.body?.data) ? response.body.data : [];
    const owners = models.map(model => model && typeof model === 'object' ? (model as Record<string, unknown>).owned_by : null);
    if (owners.includes('vllm-mlx') && owners.every(owner => ['vllm-mlx', 'vllm-mlx-embedding', 'vllm-mlx-reranker'].includes(String(owner)))) slot.runtime = 'vllm-mlx';
  }
  if (!slot.runtime) throw new UnsupportedRuntime('unsupported');
  return slot.runtime;
};
const legacyHint = (id: string, name: unknown): Runtime | null => {
  const value = `${id} ${typeof name === 'string' ? name : ''}`.toLowerCase();
  const providerName = typeof name === 'string' ? name.trim() : '';
  if (/bionic|lm[\s_-]*studio/.test(value)) return 'lmstudio';
  if (id.trim().toLowerCase() === 'splash' || /splash/i.test(providerName)) return 'splash';
  if (/vllm[\s_-]*mlx/.test(value)) return 'vllm-mlx';
  if (/omlx/.test(value)) return 'omlx';
  return /mlx[\s_-]*lm/.test(value) ? 'mlx-lm' : null;
};

type Reply = { status: number; body?: unknown } | 'network' | 'redirect' | 'invalid';
const vllmHealth = { model_loaded: true, engine_type: 'batched', model_type: 'llm', available_models: ['fixture'] };
const MATRIX: Record<string, Record<string, Reply>> = {
  '/health': {
    omlx: { status: 200, body: { status: 'healthy', engine_pool: { model_count: 1 } } }, 'omlx loading': { status: 503, body: { status: 'loading', engine_pool: { model_count: 0 } } },
    vllm: { status: 200, body: vllmHealth }, 'vllm 503': { status: 503, body: vllmHealth }, generic: { status: 200, body: { status: 'ok' } },
    '401': { status: 401 }, '403': { status: 403 }, '404': { status: 404 }, '500': { status: 500 }, network: 'network', redirect: 'redirect',
  },
  '/api/v1/models': {
    lmstudio: { status: 200, body: { models: [] } }, 'v0 only': { status: 200, body: { error: 'Unexpected endpoint or method.' } },
    '404': { status: 404 }, '401': { status: 401 }, '500': { status: 500 },
  },
  '/status': {
    splash: { status: 200, body: { ready: false } }, 'not boolean': { status: 200, body: { ready: 'yes' } }, '404': { status: 404 },
    '405': { status: 405 }, '401': { status: 401 }, invalid: 'invalid',
  },
  '/v1/models': {
    vllm: { status: 200, body: { data: [{ owned_by: 'vllm-mlx' }, { owned_by: 'vllm-mlx-embedding' }] } },
    mixed: { status: 200, body: { data: [{ owned_by: 'vllm-mlx' }, { owned_by: 'mlx' }, null, [], 0] } }, empty: { status: 200, body: { data: [] } },
    '404': { status: 404 }, '401': { status: 401 },
  },
};
const reader = (table: Record<string, Reply>, calls: string[]): Read => (path, authenticated = true) => requestJSON({
  url: new URL(path, 'http://127.0.0.1:8000/'), timeoutMs: 1_000, allowLoadingHealth: path === '/health',
  init: { method: 'GET', headers: authenticated ? { Authorization: 'Bearer fixture-key' } : {} },
  fetchImpl: async (_url, init) => {
    calls.push(`${path}${new Headers(init?.headers).has('authorization') ? ' +key' : ''}`);
    const reply = table[path]!;
    if (reply === 'network') throw new TypeError('fetch failed');
    if (reply === 'redirect') return new Response('', { status: 302, headers: { location: 'http://127.0.0.1:9000/' } });
    if (reply === 'invalid') return new Response('{', { status: 200 });
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
  },
});
const settle = async (run: () => Promise<Runtime | null>) => {
  try { const runtime = await run(); return runtime ? { runtime } : { unsupported: true }; }
  catch (error) {
    if (error instanceof HttpFailure) return { failure: error.reason, status: error.status };
    return error instanceof UnsupportedRuntime ? { unsupported: true } : { thrown: String(error) };
  }
};

test('detection reproduces 1.6 for every combination of probe replies, including which probes were sent and with which key', async () => {
  const rows = Object.entries(MATRIX['/health']!).flatMap(([health, a]) => Object.entries(MATRIX['/api/v1/models']!).flatMap(([models, b]) =>
    Object.entries(MATRIX['/status']!).flatMap(([status, c]) => Object.entries(MATRIX['/v1/models']!).map(([openai, d]) =>
      ({ name: `${health} · ${models} · ${status} · ${openai}`, table: { '/health': a, '/api/v1/models': b, '/status': c, '/v1/models': d } })))));
  expect(rows.length).toBe(1_650);
  const seen = new Set<string>();
  for (const { name, table } of rows) {
    const legacyCalls: string[] = [], calls: string[] = [];
    const expected = await settle(() => legacyDetect(reader(table, legacyCalls)));
    const actual = await settle(async () => (await detectRuntime(reader(table, calls)))?.runtime ?? null);
    expect(actual, name).toEqual(expected);
    expect(calls, name).toEqual(legacyCalls);
    seen.add(JSON.stringify(expected));
  }
  // The matrix reaches every outcome: each runtime, each failure, and "not a supported runtime".
  expect([...seen].sort()).toEqual([
    '{"failure":"authentication_failed","status":401}', '{"failure":"runtime_unreachable","status":404}',
    '{"failure":"runtime_unreachable","status":500}', '{"failure":"runtime_unreachable","status":null}',
    '{"runtime":"lmstudio"}', '{"runtime":"omlx"}', '{"runtime":"splash"}', '{"runtime":"vllm-mlx"}', '{"unsupported":true}',
  ]);
});

test('each identification carries its confidence and the probe that made it', async () => {
  const detect = (table: Record<string, Reply>) => detectRuntime(reader({ '/health': { status: 404 }, '/api/v1/models': { status: 404 }, '/status': { status: 404 },
    '/v1/models': { status: 200, body: { data: [] } }, ...table }, []));
  expect(await detect({ '/health': MATRIX['/health']!.omlx! })).toEqual({ runtime: 'omlx', confidence: 'high', probe: '/health' });
  expect(await detect({ '/health': MATRIX['/health']!.vllm! })).toEqual({ runtime: 'vllm-mlx', confidence: 'medium', probe: '/health' });
  expect(await detect({ '/api/v1/models': MATRIX['/api/v1/models']!.lmstudio! })).toEqual({ runtime: 'lmstudio', confidence: 'medium', probe: '/api/v1/models' });
  expect(await detect({ '/status': MATRIX['/status']!.splash! })).toEqual({ runtime: 'splash', confidence: 'medium', probe: '/status' });
  expect(await detect({ '/v1/models': MATRIX['/v1/models']!.vllm! })).toEqual({ runtime: 'vllm-mlx', confidence: 'high', probe: '/v1/models' });
  expect(await detect({})).toBeNull();
});

test('provider hints keep their 1.6 precedence', () => {
  const ids = ['omlx', 'lmstudio', 'bionic', 'splash', ' Splash ', 'vllm-mlx', 'vllm_mlx', 'mlx-lm', 'mlx lm', 'custom', 'my-omlx', 'lm-studio-omlx', 'splash-omlx'];
  const names = [undefined, '', 'oMLX', 'LM Studio', 'Splash (Bionic)', 'Splash', 'vLLM MLX', 'mlx_lm server', 'Local', 42];
  for (const id of ids) for (const name of names) expect(hintFor(id, name), `${id} / ${String(name)}`).toBe(legacyHint(id, name));
  expect(DESCRIPTORS.map(item => [item.id, item.hints('x', `${item.id} server`)])).toEqual(DESCRIPTORS.map(item => [item.id, true]));
});

test('descriptors keep the 1.6 cadences and capability tiers', () => {
  expect(DESCRIPTORS.map(item => item.id)).toEqual(['omlx', 'lmstudio', 'mlx-lm', 'vllm-mlx', 'splash']);
  expect([null, 'omlx', 'lmstudio', 'mlx-lm', 'vllm-mlx', 'splash'].map(runtime => cadenceOf(runtime as Runtime | null, { activity: false })))
    .toEqual([450, 450, 5_000, 2_000, 450, 2_000]);
  expect(cadenceOf('lmstudio', { activity: true })).toBe(1_000);
  const reading = (overrides: Partial<TelemetrySnapshot>): TelemetrySnapshot =>
    ({ ...unavailableTelemetry('unsupported_contract', null, 0), available: true, reason: null, ...overrides }) as TelemetrySnapshot;
  const idle = reading({ phase: 'idle', activeRequests: 0 }), unknown = reading({ phase: 'unknown', activeRequests: null });
  const down = unavailableTelemetry('runtime_unreachable', null, 0);
  expect(DESCRIPTORS.map(item => [item.id, [idle, unknown, down].map(value => item.capabilities(value))])).toEqual([
    ['omlx', ['requests', 'requests', 'requests']], ['lmstudio', ['requests', 'inventory', 'inventory']], ['mlx-lm', ['inventory', 'inventory', 'inventory']],
    ['vllm-mlx', ['requests', 'server', 'requests']], ['splash', ['server', 'server', 'server']],
  ]);
  expect(descriptor('mlx-lm').detect).toEqual([]);
});
