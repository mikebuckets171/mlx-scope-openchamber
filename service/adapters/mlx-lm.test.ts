import { expect, test } from 'bun:test';
import { HttpFailure } from '../http.ts';
import { mlxLmDescriptor } from './mlx-lm.ts';
import { READ, routeContext, type Route } from './testing.ts';

const setup = (routes: Record<string, Route>) => {
  const clock = { now: 1_000 };
  const { context, paths } = routeContext(() => routes, clock);
  const adapter = mlxLmDescriptor.create(context);
  return { adapter, paths, clock, routes, read: () => adapter.read(READ) };
};
const catalog = (count = 22) => ({ object: 'list', data: [{ id: '/private/models/local-model' }, { id: 'mlx-community/example', context: 65536 },
  ...Array.from({ length: count - 2 }, (_, n) => ({ id: `model-${n}` }))] });

test('mlx-lm reports reachability and a bounded catalogue without inventing residency or inference', async () => {
  const reading = await setup({ '/health': { status: 'ok' }, '/v1/models': catalog() }).read();
  expect(reading.status).toEqual({ state: 'ready', reason: null, params: {} });
  expect(reading.runtime).toMatchObject({ phase: 'unknown', request: null, server: { active: null, queued: null }, residency: [], memory: {} });
  expect(reading.runtime.catalog).toHaveLength(12);
  expect(reading.runtime.catalog[0]).toEqual({ name: 'local-model', loaded: null, format: 'mlx', contextWindowTokens: null });
  expect(reading.capabilities).toEqual({ 'server.catalog': { scope: 'server', basis: 'reported' } });
  expect(JSON.stringify(reading)).not.toContain('/private');
});

test('mlx-lm caches the expensive catalogue scan for a minute', async () => {
  let reads = 0;
  const f = setup({ '/health': { status: 'ok' } });
  Object.defineProperty(f.routes, '/v1/models', { enumerable: true, get: () => ({ object: 'list', data: [{ id: `model-${++reads}` }] }) });
  const first = await f.read();
  first.runtime.catalog[0]!.name = 'mutated outside the adapter';
  f.clock.now += 59_999;
  expect((await f.read()).runtime.catalog[0]!.name).toBe('model-1');
  f.clock.now += 1;
  expect((await f.read()).runtime.catalog[0]!.name).toBe('model-2');
  expect(new Set(f.paths)).toEqual(new Set(['/health', '/v1/models']));
});

test('an unavailable catalogue degrades the catalog capability; the server stays reachable', async () => {
  for (const response of [500, 404, null, {}, { object: 'list', data: 'x' }, new HttpFailure('runtime_unreachable', 'timed out')] as Route[]) {
    const f = setup({ '/health': { status: 'ok' }, '/v1/models': response });
    const reading = await f.read();
    expect([reading.status.state, reading.capabilities, reading.runtime.catalog], String(response)).toEqual(['ready', {}, []]);
    // Retried with the next minute, never at live cadence.
    f.clock.now += 2_000; await f.read();
    expect(f.paths.filter(path => path === '/v1/models')).toHaveLength(1);
  }
  // An empty list is a reported, empty catalogue: it never claims that no model is loaded.
  const empty = await setup({ '/health': { status: 'ok' }, '/v1/models': { object: 'list', data: [] } }).read();
  expect([empty.capabilities['server.catalog']?.basis, empty.runtime.catalog, empty.runtime.residency]).toEqual(['reported', [], []]);
});

test('a rejected catalogue key is never hidden behind the anonymous health check', async () => {
  const f = setup({ '/health': { status: 'ok' }, '/v1/models': 401 });
  expect((await f.read()).status).toEqual({ state: 'failing', reason: 'authentication_failed', params: {} });
  expect((await f.read()).status.reason).toBe('authentication_failed');
  expect(f.paths).toEqual(['/health', '/v1/models', '/health', '/v1/models']);
});

test('mlx-lm health: unhealthy is unreachable, a missing route is another server, and neither scans the catalogue', async () => {
  for (const health of [{ status: 'unavailable' }, { status: 'healthy' }, {}, 500, 503]) {
    const f = setup({ '/health': health, '/v1/models': catalog(3) });
    await expect(f.read()).rejects.toMatchObject({ reason: 'runtime_unreachable' });
    expect(f.paths).toEqual(['/health']);
  }
  for (const health of [404, { status: 200, body: { error: 'Unexpected endpoint or method.' }, routeMissing: true }] as Route[]) {
    const f = setup({ '/health': health });
    expect((await f.read()).status).toEqual({ state: 'degraded', reason: 'unsupported_contract', params: {} });
    expect(f.paths).toEqual(['/health']);
  }
  const failure = new HttpFailure('runtime_unreachable', 'refused');
  const f = setup({ '/health': failure });
  await expect(f.read()).rejects.toBe(failure);
});

test('mlx-lm is found by hint only, and its identity is its health check', async () => {
  expect(mlxLmDescriptor.detect).toEqual([]);
  expect([mlxLmDescriptor.hints('mlx-lm', ''), mlxLmDescriptor.hints('local', 'mlx_lm server'), mlxLmDescriptor.hints('omlx', '')]).toEqual([true, true, false]);
  expect(await setup({ '/health': { status: 'ok' } }).adapter.identity()).toBe(true);
  expect(await setup({ '/health': { status: 'healthy', engine_pool: {} } }).adapter.identity()).toBe(false);
});
