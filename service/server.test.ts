import { afterEach, expect, test } from 'bun:test';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostFromV1 } from '../src/contract/convert-v1.ts';
import { classAKeys, MAX_BODY_CHARS } from '../src/contract/guards.ts';
import { honestyViolations, parseSnapshotV2, type SnapshotV2, type StatusV2 } from '../src/contract/snapshot.ts';
import { parseSystemSnapshot } from '../src/system.ts';
import type { RuntimeConnectionConfig } from './config.ts';
import type { HostContext } from './host/sampler.ts';
import { ServiceHistory } from './history/history.ts';
import { RuntimeClient, type ReadingMeta, type RuntimeReading } from './runtime-client.ts';
import { createScopeServer, encode, type ServerOptions, type Sources } from './server.ts';

const NOW = 1_790_690_700_000, INSTANCE = '5c1e0a7b';
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
});
const HOST = hostFromV1(parseSystemSnapshot({ platform: 'darwin', sampledAt: NOW - 500, memoryTotalGB: 48 }))!;
const meta = (overrides: Partial<ReadingMeta> = {}): ReadingMeta => ({
  connection: { id: 'auto', label: 'Automatic', runtime: null, generation: 3, choices: [], detection: { basis: 'hint', confidence: 'medium' } },
  port: null, slot: null, failures: 0, idleMs: 0, cadenceMs: 2_000, ...overrides,
});
const reading = (status: StatusV2, overrides: Partial<RuntimeReading> = {}): RuntimeReading => ({
  at: NOW - 400, status, capabilities: {}, identity: {}, completions: [],
  runtime: { phase: 'unknown', request: null, server: { active: null, queued: null }, memory: {}, residency: [], slots: [], catalog: [], engines: [] },
  meta: meta(), ...overrides,
});
const offline = (): RuntimeReading => reading({ state: 'failing', reason: 'runtime_unreachable', params: { port: 8000 } });
const defaults: Sources = { read: async () => offline(), host: async () => HOST };
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

test('/health returns the contract body, /snapshot is retired with 410, and other paths are 404', async () => {
  let reads = 0;
  const request = await launch({ ...defaults, read: async () => { reads += 1; return offline(); } });
  const health = await request('/health');
  expect([health.status, health.headers.get('cache-control'), await health.json()]).toEqual([200, 'no-store', { ok: true, version: '2.0.0-test' }]);
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
    ['/v2/snapshot?provider=my%0Aprovider', 'provider'], [`/v2/snapshot?provider=${'x'.repeat(121)}`, 'provider'],
    ['/v2/snapshot?provider=a&provider=b', 'provider'], ['/v2/snapshot?runtime=secret-runtime', 'runtime'],
    ['/v2/snapshot?tier=deep', 'tier'], ['/v2/snapshot?detail=server&tier=glance', 'detail'], ['/v2/snapshot?surface=status&detail=server', 'detail'],
    ['/v2/snapshot?frame=NOTHEX00', 'frame'], ['/v2/snapshot?surface=window', 'surface'], ['/v2/snapshot?since=-1', 'since'],
    ['/v2/snapshot?since=1.5', 'since'], ['/v2/snapshot?mark=started.1.zzzzzzzz', 'mark'],
    [`/v2/snapshot?${Array.from({ length: 5 }, (_, index) => `mark=started.${index}.0badc0de`).join('&')}`, 'mark'],
    ['/v2/snapshot?attr=1.withheld.-', 'attr'], ['/v2/snapshot?attr=0.inferred.-', 'attr'], ['/v2/snapshot?attr=1.guessed.-', 'attr'],
    ['/v2/snapshot?attr=1.withheld.several-chats', 'attr'], ['/v2/trend?window=60', 'window'], ['/v2/trend?series=decodeTps,secret', 'series'], ['/v2/usage?range=1y', 'range'],
  ];
  for (const [path, param] of cases) {
    const response = await request(path);
    expect(response.status, path).toBe(400);
    const body = await response.json();
    expect(body, path).toEqual({ error: 'bad_query', param });
    expect(JSON.stringify(body)).not.toMatch(/secret|zzzz|NOTHEX|window=|1y|several/);
  }
  expect(reads).toBe(0);
});

test('runtime=llama-server and runtime=ollama are accepted and reach the reader as that runtime', async () => {
  const selections: unknown[] = [];
  const request = await launch({ ...defaults, read: async selection => { selections.push(selection); return offline(); } });
  for (const runtime of ['llama-server', 'ollama']) expect(parseSnapshotV2(await snapshot(request, `/v2/snapshot?runtime=${runtime}&provider=local`)), runtime).not.toBeNull();
  expect(selections).toEqual([{ provider: 'local', runtime: 'llama-server' }, { provider: 'local', runtime: 'ollama' }]);
});

test('/v2/trend and /v2/usage validate, then answer 501 until their rings exist', async () => {
  const request = await launch();
  for (const path of ['/v2/trend', '/v2/trend?window=3600&series=decodeTps,cpuFraction&provider=omlx', '/v2/usage', '/v2/usage?range=90d']) {
    const response = await request(path);
    expect(response.status, path).toBe(501);
    expect(await response.json()).toEqual({ error: 'not_implemented' });
  }
});

test('/v2/trend and /v2/usage serve their sources with the parsed query once svc-history supplies them', async () => {
  const seen: unknown[] = [];
  const trend = { contractVersion: 2 as const, serverNow: NOW, windowMs: 3_600_000 as const, bucketMs: 20_000, startAt: NOW - 3_600_000, series: {}, gaps: [], marks: [] };
  const usage = { contractVersion: 2 as const, serverNow: NOW, available: false, reason: 'not_omlx' as const, range: '90d' as const, cachedAt: NOW,
    basis: 'reported' as const, granularity: 'day' as const, buckets: [], totals: { requests: 0, promptTokens: 0, outputTokens: 0 }, models: [] };
  const request = await launch({ ...defaults, trend: async query => { seen.push(query); return trend; }, usage: async query => { seen.push(query); return usage; } });
  expect(await (await request('/v2/trend?window=3600&series=cpuFraction')).json()).toEqual(trend);
  expect(await (await request('/v2/usage?range=90d&provider=My%20oMLX')).json()).toEqual(usage);
  expect((await request('/v2/usage?range=1y')).status).toBe(400);
  expect(seen).toEqual([{ windowMs: 3_600_000, series: ['cpuFraction'] }, { provider: 'My oMLX', range: '90d' }]);
});

test('a v2 snapshot is canonical, honest, English-free and carries the service identity', async () => {
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
    status: { state: 'failing', reason: 'runtime_unreachable', params: { port: 8000 } }, runtime: { sampledAt: NOW - 400 },
    completions: { instance: INSTANCE, cursor: 0, reset: false, items: [] }, marksHead: 0, alerts: [], alertLog: [],
    lease: { leader: false, epoch: 0, ttlMs: 12_000, leaderSurface: null }, nextPollMs: 2_000,
    host: { platform: 'macOS', memTotalBytes: 48_000_000_000 }, capabilities: { 'host.memory': { basis: 'reported' } },
  });
  expect(body.compat).toBeUndefined();
});

test('status params are allowlisted per reason; nothing else a reading carries reaches the wire', async () => {
  const leaky = reading({ state: 'failing', reason: 'authentication_failed', params: { port: 8000, keySaved: false, key: 'fixture-secret', message: 'rejected' } }, {
    generationKey: 'private-key',
    meta: meta({ port: 8000, slot: 'provider\0auto' }) });
  const body = await snapshot(await launch({ ...defaults, read: async () => leaky }));
  expect(body.status).toEqual({ state: 'failing', reason: 'authentication_failed', params: { port: 8000, keySaved: false } });
  expect(JSON.stringify(body)).not.toMatch(/fixture-secret|rejected|private-key|provider\\u0000/);
});

test('host readings survive a rejected runtime read without leaking the error', async () => {
  const request = await launch({ ...defaults, read: async () => { throw Error('private api key'); } });
  const body = await snapshot(request);
  expect(body.status).toEqual({ state: 'failing', reason: 'runtime_unreachable', params: {} });
  expect(body.host).toMatchObject({ memTotalBytes: 48_000_000_000 });
  expect(JSON.stringify(body)).not.toContain('private');
});

test('runtime readings survive rejected host diagnostics', async () => {
  const request = await launch({ ...defaults, host: async () => { throw Error('OS denied'); } });
  const body = await snapshot(request);
  expect(body.host).toBeNull();
  expect(Object.keys(body.capabilities).filter(key => key.startsWith('host.'))).toEqual([]);
  expect(body.status.reason).toBe('runtime_unreachable');
  expect(JSON.stringify(body)).not.toContain('denied');
});

test('each read gets its selection and tier; the host sampler gets the tier, activity, generation and the oMLX port only', async () => {
  const selections: unknown[] = [], hosts: HostContext[] = [];
  let current = offline();
  const request = await launch({ read: async (selection, tier) => { selections.push([selection, tier]); return current; },
    host: async context => { hosts.push(context); return HOST; } });
  for (const query of ['provider=my-local&runtime=mlx-lm', 'runtime=lmstudio', 'provider=other', '', 'provider=my-local&frame=0badc0de&unknown=1',
    'provider=My%20LM%20Studio%20(Bionic)', 'runtime=llama-server', 'runtime=ollama&surface=status', 'surface=background',
    'tier=full&detail=server&provider=&runtime=splash']) {
    await snapshot(request, `/v2/snapshot?${query}`);
  }
  const full = { tier: 'full', detail: false, oneShot: false };
  expect(selections).toEqual([[{ provider: 'my-local', runtime: 'mlx-lm' }, full], [{ provider: '', runtime: 'lmstudio' }, full],
    [{ provider: 'other', runtime: null }, full], [undefined, full], [{ provider: 'my-local', runtime: null }, full],
    [{ provider: 'My LM Studio (Bionic)', runtime: null }, full], [{ provider: '', runtime: 'llama-server' }, full],
    [{ provider: '', runtime: 'ollama' }, { tier: 'glance', detail: false, oneShot: false }], [undefined, { tier: 'glance', detail: false, oneShot: true }],
    [{ provider: '', runtime: 'splash' }, { tier: 'full', detail: true, oneShot: false }]]);
  expect(hosts.at(-1)).toEqual({ tier: 'full', active: false, generation: 3, omlxPort: null });
  current = reading({ state: 'ready', reason: null, params: {} }, { runtime: { ...offline().runtime, phase: 'decode' },
    meta: meta({ port: 8001, connection: { ...meta().connection, runtime: 'omlx', generation: 7 } }) });
  await snapshot(request, '/v2/snapshot?surface=status');
  expect(hosts.at(-1)).toEqual({ tier: 'glance', active: true, generation: 7, omlxPort: 8001 });
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

/** A Bionic reading whose log stream reported one finished request; the history numbers it (seq 1) and keeps it. */
const bionic = (): RuntimeReading => reading({ state: 'ready', reason: null, params: {} }, {
  capabilities: { 'server.completions': { scope: 'server', basis: 'reported' }, 'server.requests': { scope: 'server', basis: 'observed' } },
  completions: [{ finishedAt: NOW - 42_000, startedAt: null, model: 'fixture-model', basis: 'reported', promptTokens: 1840, cachedTokens: 1126,
    outputTokens: 109, ttftMs: 470, decodeTps: 38.6, overlapped: true }],
  meta: meta({ connection: { id: 'studio', label: 'LM Studio', runtime: 'lmstudio', generation: 1, choices: [], detection: { basis: 'hint', confidence: 'medium' } },
    port: 1234, slot: 'studio\0auto' }),
});
test('attribution verdicts are kept next to their completion; the first stands unless an armed capture replaces it', async () => {
  const request = await launch({ read: async () => bionic(), host: async () => HOST, history: new ServiceHistory(INSTANCE) });
  const first = await snapshot(request);
  expect(first.completions).toMatchObject({ instance: INSTANCE, cursor: 1, reset: false });
  expect(first.completions.items).toHaveLength(1);
  expect(first.completions.items[0]).toMatchObject({ seq: 1, model: 'fixture-model', basis: 'reported', decodeTps: 38.6, ttftMs: 470, overlapped: true });
  expect(first.capabilities['server.completions']).toEqual({ scope: 'server', basis: 'reported' });
  expect(first.completions.items[0]!.verdict).toBeUndefined();
  clock.now += 1_000;
  const withheld = await snapshot(request, '/v2/snapshot?attr=1.withheld.overlap&attr=9.inferred.-');
  expect(withheld.completions.items[0]!.verdict).toEqual({ attr: 'withheld', reason: 'overlap', at: NOW + 1_000 });
  clock.now += 1_000;
  expect((await snapshot(request, '/v2/snapshot?attr=1.inferred.-')).completions.items[0]!.verdict?.attr).toBe('withheld');
  expect((await snapshot(request, '/v2/snapshot?attr=1.armed.-')).completions.items[0]!.verdict).toEqual({ attr: 'armed', at: NOW + 2_000 });
  expect((await snapshot(request, '/v2/snapshot?attr=1.withheld.model-differs')).completions.items[0]!.verdict?.attr).toBe('armed');
  // `since` returns only newer items; a cursor this ring never issued is a reset, answered with the whole ring.
  expect((await snapshot(request, '/v2/snapshot?since=1')).completions).toEqual({ instance: INSTANCE, cursor: 1, reset: false, items: [] });
  expect((await snapshot(request, '/v2/snapshot?since=0')).completions.items.map(item => item.seq)).toEqual([1]);
  const reset = (await snapshot(request, '/v2/snapshot?since=77')).completions;
  expect(reset).toMatchObject({ cursor: 1, reset: true });
  expect(reset.items.map(item => item.seq)).toEqual([1]);
});

test('a selection no slot serves has an empty ring: any cursor is a reset', async () => {
  const request = await launch();
  expect((await snapshot(request, '/v2/snapshot?since=4')).completions).toEqual({ instance: INSTANCE, cursor: 0, reset: true, items: [] });
  expect((await snapshot(request, '/v2/snapshot?since=0')).completions).toEqual({ instance: INSTANCE, cursor: 0, reset: false, items: [] });
});

test('alerts come from the history with the lease, and reach the wire only through the contract parser', async () => {
  const inputs: boolean[] = [];
  const history: NonNullable<Sources['history']> = { head: 0, record() {}, snapshot: (_key, { leader }) => {
    inputs.push(leader);
    return { completions: { instance: INSTANCE, cursor: 0, reset: false, items: [] }, alertLog: [],
      alerts: [{ id: 'runtime-lost', severity: 'critical', since: NOW - 5_000, params: { runtime: 'omlx', note: 'x' } as never, badge: true, ...leader ? { toastSeq: 1 } : {} }] };
  } };
  const request = await launch({ ...defaults, history });
  const body = await snapshot(request, '/v2/snapshot?surface=panel&frame=00000001');
  expect(body.alerts).toEqual([{ id: 'runtime-lost', severity: 'critical', since: NOW - 5_000, params: { runtime: 'omlx' }, badge: true, toastSeq: 1 }]);
  expect(inputs).toEqual([true]);
});

test('history segments tolerate the Energy-saving floor of the frame surface', async () => {
  const polls: Array<number | undefined> = [];
  const history: NonNullable<Sources['history']> = { head: 0, record: (_key, _reading, _host, context) => { polls.push(context.pollMs); },
    snapshot: () => ({ completions: { instance: INSTANCE, cursor: 0, reset: false, items: [] }, alerts: [], alertLog: [] }) };
  const request = await launch({ ...defaults, history });
  for (const surface of ['status', 'panel', 'page']) await snapshot(request, `/v2/snapshot?surface=${surface}&frame=00000002`);
  // A status frame under Energy saving polls every 5 s at most, panel and page every 3 s: a segment must span that.
  expect(polls.map(ms => (ms ?? 0) >= 5_000)).toEqual([true, false, false]);
  expect(polls.slice(1).every(ms => (ms ?? 0) >= 3_000)).toBe(true);
});

test('the next poll follows the reading, the backoff and the surface', async () => {
  let current: RuntimeReading = offline();
  const request = await launch({ ...defaults, read: async () => current });
  const poll = async (query = '') => (await snapshot(request, `/v2/snapshot?${query}`)).nextPollMs;
  expect(await poll()).toBe(2_000);
  current = { ...offline(), meta: meta({ failures: 1 }) };
  expect(await poll()).toBe(1_000);
  current = { ...offline(), meta: meta({ failures: 4 }) };
  expect(await poll()).toBe(2_000);
  expect(await poll('surface=status')).toBe(3_000);
  current = reading({ state: 'ready', reason: null, params: {} }, { runtime: { ...offline().runtime, phase: 'decode' } });
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
