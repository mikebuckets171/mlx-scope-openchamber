import { afterEach, expect, test } from 'bun:test';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CompanionSetupStatus } from './companion-setup.ts';
import type { RuntimeConnectionConfig } from './config.ts';
import { RuntimeClient } from './runtime-client.ts';
import { createScopeServer, unread, type Sources } from './server.ts';
import { parseSnapshotV2 } from '../src/contract/snapshot.ts';

const NOW = 1_790_690_700_000, PATH = '/v2/companion/setup';
const AUTH = { Authorization: 'Bearer test-v3-token' }, JSON_HEADERS = { ...AUTH, 'Content-Type': 'application/json' };
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
});
const state = (): CompanionSetupStatus => ({ state: 'pending', message: 'Chat tracking starts when OpenChamber loads this extension’s helper into OpenCode.',
  configured: false, managed: false, canEnable: false, canDisable: false, runtimeVersion: null, companionVersion: null, protocol: null, live: false });
async function launch(sources: Sources, now: () => number = () => NOW) {
  const server = createScopeServer('test-v3-token', sources, { now, monotonic: () => 1_000, instance: '01234567', version: '3.0.0-test' });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (path = PATH, init: RequestInit = {}) => fetch(base + path, { headers: AUTH, ...init });
}
async function fixture() {
  const calls = { status: 0, read: 0 };
  const request = await launch({ read: async () => { calls.read++; return unread(NOW); }, companionSetup: { status: async () => { calls.status++; return state(); } } });
  return { request, calls };
}

test('companion GET reports status without reading the runtime', async () => {
  const { request, calls } = await fixture();
  for (const path of [PATH, `${PATH}?action=enable`, `${PATH}?action=disable`]) {
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual(state());
  }
  expect(calls).toEqual({ status: 3, read: 0 });
});

test('setup is read-only: every other method is refused before anything runs', async () => {
  const { request, calls } = await fixture();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await request(PATH, { method, headers: JSON_HEADERS, body: method === 'OPTIONS' ? undefined : '{"action":"enable"}' });
    expect(response.status, method).toBe(405); expect(await response.json()).toEqual({ error: 'method_not_allowed' });
  }
  expect(calls).toEqual({ status: 0, read: 0 });
});

test('setup authorization is checked before reading status', async () => {
  const { request, calls } = await fixture();
  for (const method of ['GET', 'POST']) for (const token of [null, 'Bearer wrong', 'Bearer test-v3-token-extra']) {
    const response = await request(PATH, { method, headers: { 'Content-Type': 'application/json', ...token ? { Authorization: token } : {} },
      ...method === 'POST' ? { body: '{"action":"enable"}' } : {} });
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'unauthorized' });
  }
  expect(calls).toEqual({ status: 0, read: 0 });
});

test('setup errors are sanitized and do not affect the existing read routes', async () => {
  const request = await launch({ read: async () => unread(NOW), companionSetup: {
    status: async () => { throw new Error('private file /tmp/fixture-secret/config'); },
  } });
  const response = await request(PATH);
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'service_unavailable' });
  const health = await request('/health'); expect(await health.json()).toEqual({ ok: true, version: '3.0.0-test' });
  const snapshot = await request('/v2/snapshot'); expect(snapshot.status).toBe(200);
  expect(parseSnapshotV2(await snapshot.json())).not.toBeNull();
  for (const path of ['/health', '/v2/snapshot', '/v2/trend', '/v2/usage']) {
    expect((await request(path, { method: 'POST', headers: JSON_HEADERS, body: '{"action":"enable"}' })).status).toBe(405);
  }
  expect((await request('/snapshot')).status).toBe(410);
  expect((await request('/v2/trend')).status).toBe(501);
  expect((await request('/v2/usage')).status).toBe(501);
  expect((await request(`${PATH}/extra`)).status).toBe(404);
});

test('a service without a setup source exposes no write route', async () => {
  const request = await launch({ read: async () => unread(NOW) });
  expect((await request()).status).toBe(404);
  expect((await request(PATH, { method: 'POST', headers: JSON_HEADERS, body: '{"action":"enable"}' })).status).toBe(405);
});

test('a selected cloud provider never falls through to a local runtime or Mac sampler', async () => {
  let requests = 0, samples = 0;
  const local: RuntimeConnectionConfig = { id: 'local', label: 'Local', runtime: 'mlx-lm', config: {
    baseURL: new URL('http://127.0.0.1:8000'), apiKey: null, preferredModel: null, issue: 'missing_credential',
    source: 'opencode', configStatus: 'present', authStatus: 'missing', error: null,
  } };
  const client = new RuntimeClient({ now: () => NOW, readConfig: async () => ({ connections: [local], issue: 'none', error: null }),
    fetchImpl: async () => { requests++; return new Response(JSON.stringify({ data: [{ id: 'local-model' }] }), { headers: { 'Content-Type': 'application/json' } }); } });
  try {
    const request = await launch({ read: (selection, input) => client.read(selection, input), host: async () => { samples++; return null; } });
    const response = await request(`/v2/snapshot?provider=cloud-provider&chat=${'a'.repeat(64)}&chatModel=${'b'.repeat(64)}&surface=status&frame=12345678`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(parseSnapshotV2(body)).not.toBeNull();
    expect(body.status).toEqual({ state: 'unconfigured', reason: 'configuration_missing', params: { issue: 'removed' } });
    expect(body.connection).toMatchObject({ id: 'auto', runtime: null });
    expect(body.runtime).toMatchObject({ phase: 'unknown', request: null, server: { active: null, queued: null } });
    expect(body.host).toBeNull(); expect(body.chat).toBeUndefined(); expect(body.nextPollMs).toBeGreaterThanOrEqual(10_000);
    expect([requests, samples]).toEqual([0, 0]);
    expect(await client.companionTarget('cloud-provider')).toBeNull();
    expect(await client.companionTarget('local')).toMatchObject({ providerKey: expect.stringMatching(/^[a-f0-9]{64}$/), endpointKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await request('/v2/snapshot?provider=local');
    expect(requests).toBeGreaterThan(0); expect(samples).toBe(1);
  } finally { client.dispose(); }
});

test('response time includes a newer chat observation collected after awaited runtime IO', async () => {
  let now = NOW;
  const measurement = { scope: 'chat', basis: 'estimated-characters', timingBasis: 'delivery-window', phase: 'generating',
    tokensPerSecond: 42, observedAtMs: NOW + 750, expiresAtMs: NOW + 5_750,
    observation: { startedAtMs: NOW - 2_250, endedAtMs: NOW + 750 }, freshness: 'live' } as const;
  const request = await launch({
    read: async () => { await Promise.resolve(); now += 500; return unread(now); },
    chat: async () => { await Promise.resolve(); now += 250; return measurement; },
  }, () => now);
  const response = await request('/v2/snapshot');
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.serverNow).toBe(NOW + 750);
  expect(body.chat).toEqual(measurement);
  expect(parseSnapshotV2(body)?.chat).toEqual(measurement);
});
