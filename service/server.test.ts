import { afterEach, expect, test } from 'bun:test';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createScopeServer, encode, type ServerOptions, type Sources } from './server.ts';
import { LMStudioClient } from './lmstudio.ts';
import type { LMStudioActivityView } from './lmstudio-activity.ts';
import type { RuntimeReading } from './runtime-client.ts';
import { unavailableTelemetry, type TelemetrySnapshot } from '../src/telemetry.ts';
import { parseSystemSnapshot } from '../src/system.ts';
import { classAKeys, MAX_BODY_CHARS } from '../src/contract/guards.ts';
import { honestyViolations, parseSnapshotV2, type SnapshotV2 } from '../src/contract/snapshot.ts';

const NOW = 1_790_690_700_000, INSTANCE = '5c1e0a7b';
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
});
const host = parseSystemSnapshot({ platform: 'darwin', sampledAt: NOW - 500, memoryTotalGB: 48 })!;
const meta = (overrides: Partial<RuntimeReading['meta']> = {}): RuntimeReading['meta'] =>
  ({ generation: 3, detection: { basis: 'hint', confidence: 'medium' }, failures: 0, idleMs: 0, completionSeq: null, ...overrides });
const offline = (): RuntimeReading => ({ snapshot: unavailableTelemetry('runtime_unreachable', 'Offline.', NOW - 400), meta: meta() });
const defaults: Sources = { read: async () => offline(), system: async () => host };
const clock = { now: NOW, monotonic: 1_000 };
const launch = async (sources: Sources = defaults, options: ServerOptions = {}) => {
  clock.now = NOW; clock.monotonic = 1_000;
  const server = createScopeServer('test-token', sources, { version: '2.0.0-test', instance: INSTANCE, now: () => clock.now, monotonic: () => clock.monotonic, ...options });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (path: string, init: RequestInit = {}) => fetch(url + path, { headers: { Authorization: 'Bearer test-token' }, ...init });
};
const snapshot = async (request: Awaited<ReturnType<typeof launch>>, path = '/v2/snapshot'): Promise<SnapshotV2> => {
  const response = await request(path);
  expect(response.status).toBe(200);
  return response.json();
};

test('every route requires the whole bearer token', async () => {
  const request = await launch();
  for (const path of ['/health', '/snapshot', '/v2/snapshot', '/v2/trend', '/v2/usage', '/other']) {
    for (const authorization of [null, 'Bearer wrong', 'Bearer test-toke', 'Bearer test-token2', 'bearer test-token', 'test-token']) {
      const response = await request(path, { headers: authorization === null ? {} : { Authorization: authorization } });
      expect(response.status, `${path} with ${authorization}`).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    }
  }
  expect((await request('/health')).status).toBe(200);
});

test('only GET is served', async () => {
  const request = await launch();
  for (const path of ['/v2/snapshot', '/health', '/snapshot', '/models/unload']) {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) expect((await request(path, { method })).status, `${method} ${path}`).toBe(405);
  }
});

test('/health is unchanged, /snapshot is retired with 410, and other paths are 404', async () => {
  let reads = 0;
  const request = await launch({ ...defaults, read: async () => { reads += 1; return offline(); } });
  expect(await (await request('/health')).json()).toEqual({ status: 'healthy' });
  const retired = await request('/snapshot?provider=omlx');
  expect(retired.status).toBe(410);
  expect(retired.headers.get('cache-control')).toBe('no-store');
  expect(await retired.json()).toEqual({ error: 'contract_mismatch', contractVersion: 2 });
  for (const path of ['/models/unload', '/v2', '/v2/', '/v2/snapshot/extra', '/v2/runtimes', '/V2/snapshot', '/snapshot/']) {
    const response = await request(path);
    expect(response.status, path).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  }
  expect(reads).toBe(0);
});

test('malformed parameters are 400 bad_query naming only the parameter, and never reach a collector', async () => {
  let reads = 0;
  const request = await launch({ ...defaults, read: async () => { reads += 1; return offline(); } });
  const cases: Array<[string, string]> = [
    ['/v2/snapshot?provider=my%20provider', 'provider'], [`/v2/snapshot?provider=${'x'.repeat(65)}`, 'provider'],
    ['/v2/snapshot?provider=a&provider=b', 'provider'], ['/v2/snapshot?runtime=secret-runtime', 'runtime'],
    // Stage 2a serves the 1.6 runtimes only.
    ['/v2/snapshot?runtime=ollama', 'runtime'], ['/v2/snapshot?runtime=llama-server', 'runtime'],
    ['/v2/snapshot?tier=deep', 'tier'], ['/v2/snapshot?detail=server&tier=glance', 'detail'], ['/v2/snapshot?surface=status&detail=server', 'detail'],
    ['/v2/snapshot?frame=NOTHEX00', 'frame'], ['/v2/snapshot?surface=window', 'surface'], ['/v2/snapshot?since=-1', 'since'],
    ['/v2/snapshot?since=1.5', 'since'], ['/v2/snapshot?mark=started.1.zzzzzzzz', 'mark'],
    [`/v2/snapshot?${Array.from({ length: 5 }, (_, index) => `mark=started.${index}.0badc0de`).join('&')}`, 'mark'],
    ['/v2/snapshot?attr=1.withheld.-', 'attr'], ['/v2/snapshot?attr=0.inferred.-', 'attr'], ['/v2/snapshot?attr=1.guessed.-', 'attr'],
    ['/v2/trend?window=60', 'window'], ['/v2/trend?series=decodeTps,secret', 'series'], ['/v2/usage?range=1y', 'range'],
  ];
  for (const [path, param] of cases) {
    const response = await request(path);
    expect(response.status, path).toBe(400);
    const body = await response.json();
    expect(body, path).toEqual({ error: 'bad_query', param });
    expect(JSON.stringify(body)).not.toMatch(/secret|zzzz|NOTHEX|window=|1y/);
  }
  expect(reads).toBe(0);
});

test('/v2/trend and /v2/usage validate, then answer 501 until their rings exist', async () => {
  const request = await launch();
  for (const path of ['/v2/trend', '/v2/trend?window=3600&series=decodeTps,cpuFraction&provider=omlx', '/v2/usage', '/v2/usage?range=90d']) {
    const response = await request(path);
    expect(response.status, path).toBe(501);
    expect(await response.json()).toEqual({ error: 'not_implemented' });
  }
});

test('a v2 snapshot is canonical, honest and carries the service identity', async () => {
  const request = await launch();
  const response = await request('/v2/snapshot');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  const body = await response.json();
  expect(parseSnapshotV2(body)).toEqual(body);
  expect(honestyViolations(body)).toEqual([]);
  expect(classAKeys(body)).toEqual([]);
  expect(body).toMatchObject({
    contractVersion: 2, serverNow: NOW, service: { version: '2.0.0-test', instance: INSTANCE },
    connection: { id: 'auto', generation: 3, detection: { basis: 'hint', confidence: 'medium' } },
    status: { state: 'failing', reason: 'runtime_unreachable' },
    completions: { instance: INSTANCE, cursor: 0, reset: false, items: [] }, marksHead: 0, alerts: [], alertLog: [],
    lease: { leader: false, epoch: 0, ttlMs: 12_000, leaderSurface: null }, nextPollMs: 2_000,
    host: { platform: 'macOS', memTotalBytes: 48_000_000_000 },
  });
});

test('host readings survive a rejected runtime read without leaking the error', async () => {
  const request = await launch({ ...defaults, read: async () => { throw Error('private api key'); } });
  const body = await snapshot(request);
  expect(body.status).toEqual({ state: 'failing', reason: 'runtime_unreachable', params: {} });
  expect(body.compat?.message).toBe('Local inference telemetry is unavailable.');
  expect(body.host).toMatchObject({ memTotalBytes: 48_000_000_000 });
  expect(JSON.stringify(body)).not.toContain('private');
});

test('runtime readings survive rejected host diagnostics', async () => {
  const request = await launch({ ...defaults, system: async () => { throw Error('OS denied'); } });
  const body = await snapshot(request);
  expect(body.host).toBeNull();
  expect(body.compat?.message).toBe('Offline.');
  expect(JSON.stringify(body)).not.toContain('denied');
});

test('the selection is scoped to each read', async () => {
  const selections: unknown[] = [];
  const request = await launch({ ...defaults, read: async selection => { selections.push(selection); return offline(); } });
  for (const query of ['provider=my-local&runtime=mlx-lm', 'runtime=lmstudio', 'provider=other', '', 'provider=my-local&frame=0badc0de&unknown=1']) {
    await snapshot(request, `/v2/snapshot?${query}`);
  }
  expect(selections).toEqual([{ provider: 'my-local', runtime: 'mlx-lm' }, { provider: '', runtime: 'lmstudio' },
    { provider: 'other', runtime: null }, undefined, { provider: 'my-local', runtime: null }]);
});

test('the lease elects page over panel over status among recent frames, and lower frames back off', async () => {
  const request = await launch();
  const poll = async (frame: string | null, surface: string) => snapshot(request, `/v2/snapshot?surface=${surface}${frame ? `&frame=${frame}` : ''}`);
  expect((await poll('00000001', 'status')).lease).toEqual({ leader: true, epoch: 1, ttlMs: 12_000, leaderSurface: 'status' });
  expect((await poll('00000002', 'panel')).lease).toEqual({ leader: true, epoch: 2, ttlMs: 12_000, leaderSurface: 'panel' });
  const status = await poll('00000001', 'status');
  expect([status.lease.leader, status.nextPollMs]).toEqual([false, 10_000]);
  expect((await poll('00000003', 'page')).lease).toMatchObject({ leader: true, epoch: 3 });
  const panel = await poll('00000002', 'panel');
  expect([panel.lease, panel.nextPollMs]).toEqual([{ leader: false, epoch: 3, ttlMs: 12_000, leaderSurface: 'page' }, 10_000]);
  // Background frames and requests without a frame id never lead, and never displace the leader.
  expect((await poll('00000004', 'background')).lease).toMatchObject({ leader: false, leaderSurface: 'page' });
  expect((await poll(null, 'page')).lease).toMatchObject({ leader: false, epoch: 3 });
  // The page stops polling: after the TTL the panel, still polling, takes over.
  clock.monotonic += 6_000; await poll('00000002', 'panel');
  clock.monotonic += 6_000;
  expect((await poll('00000002', 'panel')).lease).toEqual({ leader: true, epoch: 4, ttlMs: 12_000, leaderSurface: 'panel' });
});

test('turn marks are deduplicated into marksHead and their tags never leave the service', async () => {
  const request = await launch();
  const mark = (value: string) => snapshot(request, `/v2/snapshot?mark=${value}`);
  expect((await mark(`started.${NOW - 2_000}.aaaaaaaa`)).marksHead).toBe(1);
  // Two frames reporting one lifecycle event.
  expect((await mark(`started.${NOW - 1_200}.aaaaaaaa`)).marksHead).toBe(1);
  expect((await mark(`completed.${NOW - 100}.aaaaaaaa`)).marksHead).toBe(2);
  expect((await mark(`started.${NOW - 100}.bbbbbbbb`)).marksHead).toBe(3);
  // A clock far ahead of the service is not a turn.
  const body = await mark(`failure.${NOW + 3_600_000}.aaaaaaaa`);
  expect(body.marksHead).toBe(3);
  expect(JSON.stringify(body)).not.toMatch(/aaaaaaaa|bbbbbbbb/);
});

const view = (lastRequest: LMStudioActivityView['lastRequest']): LMStudioActivityView => ({ active: null, concurrent: false, activeRequests: 0,
  lastRequest, completedRequests: 1, averageDecodeTPS: 38.6, cacheEfficiencyPercent: 61.2 });
const lmstudio = async (): Promise<TelemetrySnapshot> => {
  const lastRequest = { model: 'fixture-model', tokensPerSecond: 38.6, ttftSeconds: 0.47, promptTokens: 1840, cachedTokens: 1126, outputTokens: 109, finishedAt: NOW - 42_000 };
  const reading = await new LMStudioClient(async () => ({ models: [{ type: 'llm', key: 'fixture-model', format: 'mlx', max_context_length: 8192,
    loaded_instances: [{ id: 'fixture-model', config: { context_length: 8192 } }] }] }), () => NOW - 300, { touch() {}, view: () => view(lastRequest) }).snapshot();
  return { ...reading, connection: { selected: 'studio', label: 'LM Studio', runtime: 'lmstudio', choices: [{ id: 'studio', label: 'LM Studio', runtime: 'lmstudio' }],
    diagnostic: 'ready', coverage: 'requests', generation: null } };
};

test('attribution verdicts are kept next to their completion; the first stands unless an armed capture replaces it', async () => {
  const reading = await lmstudio();
  const request = await launch({ read: async () => ({ snapshot: reading, meta: meta({ completionSeq: 5 }) }), system: async () => host, completionHead: () => 5 });
  const first = await snapshot(request);
  expect(first.completions).toMatchObject({ instance: INSTANCE, cursor: 5, reset: false });
  expect(first.completions.items).toHaveLength(1);
  expect(first.completions.items[0]).toMatchObject({ seq: 5, model: 'fixture-model', basis: 'reported', decodeTps: 38.6, ttftMs: 470, overlapped: true });
  expect(first.completions.items[0]!.verdict).toBeUndefined();
  clock.now += 1_000;
  const withheld = await snapshot(request, '/v2/snapshot?attr=5.withheld.several-chats&attr=9.inferred.-');
  expect(withheld.completions.items[0]!.verdict).toEqual({ attr: 'withheld', reason: 'several-chats', at: NOW + 1_000 });
  clock.now += 1_000;
  expect((await snapshot(request, '/v2/snapshot?attr=5.inferred.-')).completions.items[0]!.verdict?.attr).toBe('withheld');
  expect((await snapshot(request, '/v2/snapshot?attr=5.armed.-')).completions.items[0]!.verdict).toEqual({ attr: 'armed', at: NOW + 2_000 });
  expect((await snapshot(request, '/v2/snapshot?attr=5.withheld.overlap')).completions.items[0]!.verdict?.attr).toBe('armed');
  // `since` returns only newer items; a cursor this ring never issued is a reset.
  expect((await snapshot(request, '/v2/snapshot?since=5')).completions).toEqual({ instance: INSTANCE, cursor: 5, reset: false, items: [] });
  expect((await snapshot(request, '/v2/snapshot?since=4')).completions.items.map(item => item.seq)).toEqual([5]);
  expect((await snapshot(request, '/v2/snapshot?since=77')).completions).toMatchObject({ cursor: 5, reset: true, items: [] });
});

test('the next poll follows the reading, the backoff and the surface', async () => {
  let current: RuntimeReading = offline();
  const request = await launch({ ...defaults, read: async () => current });
  const poll = async (query = '') => (await snapshot(request, `/v2/snapshot?${query}`)).nextPollMs;
  expect(await poll()).toBe(2_000);
  current = { snapshot: current.snapshot, meta: meta({ failures: 1 }) };
  expect(await poll()).toBe(1_000);
  current = { snapshot: current.snapshot, meta: meta({ failures: 4 }) };
  expect(await poll()).toBe(2_000);
  expect(await poll('surface=status')).toBe(3_000);
  current = { snapshot: { ...await lmstudio(), phase: 'decode' }, meta: meta() };
  expect([await poll(), await poll('surface=page'), await poll('surface=status')]).toEqual([500, 500, 1_000]);
});

test('no body leaves at or above the SDK response limit', async () => {
  expect(() => encode({ text: 'x'.repeat(MAX_BODY_CHARS) })).toThrow(RangeError);
  expect(encode({ ok: true })).toBe('{"ok":true}');
  // A body the contract refuses is never sent; the frame gets a generic failure instead.
  const request = await launch(defaults, { instance: 'not-hex' });
  const response = await request('/v2/snapshot');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'service_unavailable' });
});
