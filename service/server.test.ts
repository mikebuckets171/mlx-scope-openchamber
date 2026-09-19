import { afterEach, expect, test } from 'bun:test';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createScopeServer } from './server.ts';
import { unavailableTelemetry } from '../src/telemetry.ts';
import { parseSystemSnapshot } from '../src/system.ts';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
});
const host = parseSystemSnapshot({ platform: 'darwin', sampledAt: 100, memoryTotalGB: 48 })!;
const runtime = unavailableTelemetry('runtime_unreachable');
const defaults = { snapshot: async () => runtime, system: async () => host };
const launch = async (sources: Parameters<typeof createScopeServer>[1] = defaults) => {
  const server = createScopeServer('test-token', sources);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (path: string, init: RequestInit = {}) => fetch(url + path, { headers: { Authorization: 'Bearer test-token' }, ...init });
};

test('service requires authentication on all routes and rejects writes', async () => {
  const request = await launch();
  for (const path of ['/health', '/capabilities', '/snapshot', '/other']) expect((await request(path, { headers: {} })).status).toBe(401);
  expect((await request('/health')).status).toBe(200);
  expect((await request('/snapshot', { method: 'POST' })).status).toBe(405);
  expect((await request('/models/unload')).status).toBe(404);
});

test('host monitoring survives rejected runtime collection without leaking errors', async () => {
  const request = await launch({ ...defaults, snapshot: async () => { throw Error('private api key'); } });
  const response = await request('/snapshot');
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json();
  expect(body.available).toBe(false);
  expect(body.system).toEqual(host);
  expect(JSON.stringify(body)).not.toContain('private');
});

test('runtime response survives rejected host diagnostics', async () => {
  const request = await launch({ ...defaults, system: async () => { throw Error('OS denied'); } });
  const body = await (await request('/snapshot')).json();
  expect(body.reason).toBe(runtime.reason);
  expect(body.system).toBeNull();
});
