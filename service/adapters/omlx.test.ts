import { expect, test } from 'bun:test';
import { classAKeys } from '../../src/contract/guards.ts';
import { honestyViolations, parseSnapshotV2, type SnapshotV2 } from '../../src/contract/snapshot.ts';
import { unitViolations } from '../../src/contract/units.ts';
import type { AdapterReadingV2, ReadContext, Tier } from '../core/adapter-v2.ts';
import { HttpFailure } from '../http.ts';
import { ADMIN_RETRY_MS, isOmlxHealth, OMLX_PATHS, omlxDescriptor, OmlxAdapter } from './omlx.ts';
import { readOmlxUsage, usagePath } from './omlx-usage.ts';
import {
  admin, clock, contextFor, envelope, fakeOmlx, fixture, fixtureFiles, from, leaks, login, ok, type Call, type Route, type Version,
} from './testing/omlx.ts';

const WINDOWS = ok({ models: [{ id: 'Example-27B-4bit', max_context_window: 131_072 }, { id: 'Example-35B-A3B-4bit', max_context_window: 262_144 },
  { id: 'Example-Embed-0.6B-8bit', max_context_window: 0 }] });
/** `/api/status` takes the main key or a sub key as a bearer token (S6). */
const status = (version: Version, file: string): Route => request =>
  /^Bearer fixture-(main|sub)-key$/.test(request.headers.Authorization ?? '') ? from(version, file) : from(version, 'api-status.unauthorized.json', 401);
const server = (version: Version, { activity = version === '0.6.4' ? 'admin-api-activity.generating.json' : 'admin-api-activity.idle.json', api = 'api-status.idle.json',
  health = version === '0.6.4' ? 'health.healthy.json' : 'health.healthy-loaded.json' } = {}) => fakeOmlx({
  [OMLX_PATHS.health]: from(version, health, health.includes('loading') ? 503 : 200),
  [OMLX_PATHS.login]: login(),
  [OMLX_PATHS.activity]: admin(from(version, activity)),
  [OMLX_PATHS.status]: status(version, api),
  [OMLX_PATHS.models]: WINDOWS,
  // Served so a stray request would succeed and be seen: 2.0 never asks for it (G1).
  '/admin/api/stats': admin(from(version, 'admin-api-stats.canary.json')),
  [usagePath('7d', true)]: admin(from(version, version === '0.6.4' ? 'admin-api-usage.not-found.json' : 'admin-api-usage.7d-details.json',
    version === '0.6.4' ? 404 : 200)),
});

const ALLOWED = new Set(['GET /health', 'GET /api/status', 'GET /admin/api/activity', 'GET /v1/models/status', 'POST /admin/api/login',
  ...(['7d', '30d', '90d'] as const).map(range => `GET ${usagePath(range, range === '7d')}`)]);
/** P1: GETs to the oMLX allowlist, the admin login as the one POST, and never `/admin/api/stats`. */
const expectObserverOnly = (calls: Call[]): void => {
  expect(calls.map(call => `${call.method} ${call.path}`).filter(call => !ALLOWED.has(call))).toEqual([]);
  expect(calls.some(call => call.path.startsWith('/admin/api/stats'))).toBe(false);
};
/** A reading as a frame receives it: the body parses unchanged, honest, in contract units, and free of class A data. */
const roundTrip = (reading: AdapterReadingV2, name = ''): SnapshotV2 => {
  const body = envelope(reading);
  expect(parseSnapshotV2(body), name).toEqual(body);
  expect([honestyViolations(body), unitViolations(body), classAKeys(body), leaks(body)], name).toEqual([[], [], [], []]);
  return body;
};
const read = (adapter: OmlxAdapter, time: ReturnType<typeof clock>, tier: Tier = 'full'): Promise<AdapterReadingV2> =>
  adapter.read({ deadline: time.state.mono + 8_000, tier, detail: false } satisfies ReadContext);
const start = (version: Version, options?: Parameters<typeof server>[1], apiKey?: string | null) => {
  const fake = server(version, options), time = clock(), context = contextFor(fake.fetchImpl, time, apiKey);
  return { fake, time, context, adapter: omlxDescriptor.create(context) as OmlxAdapter };
};

test('/health identifies oMLX, including 0.7’s null engine pool, and nothing else', () => {
  for (const version of ['0.7.0rc1', '0.6.4'] as Version[]) for (const file of fixtureFiles(version, 'health.')) {
    expect(isOmlxHealth(fixture(version, file) as never, file.includes('loading') ? 503 : 200), `${version} ${file}`).toBe(true);
  }
  const vllm = { model_loaded: true, engine_type: 'batched', model_type: 'llm', available_models: ['fixture'] };
  for (const [body, code] of [[{ status: 'healthy' }, 200], [{ status: 'ok' }, 200], [{ status: 'loading model' }, 503], [vllm, 200],
    [{ status: 'healthy', engine_pool: null }, 200], [{ status: 'healthy', engine_pool: {} }, 200], [{ status: 'loading', engine_pool: null, default_model: null }, 200],
    [{ status: 'healthy', engine_pool: { model_count: 1.5 } }, 200], [fixture('0.7.0rc1', 'api-status.idle.json'), 200], [null, 200]] as const) {
    expect(isOmlxHealth(body as never, code), JSON.stringify(body)).toBe(false);
  }
  expect(omlxDescriptor).toMatchObject({ id: 'omlx', identityEveryMs: 300_000, detect: [{ probe: '/health', confidence: 'high' }] });
  expect([omlxDescriptor.hints('omlx', 'Local oMLX'), omlxDescriptor.hints('splash', 'Splash')]).toEqual([true, false]);
  expect(omlxDescriptor.detect[0]!.match({ status: 200, body: fixture('0.7.0rc1', 'health.healthy-null-pool.json') as never, routeMissing: false }, async () => {
    throw new Error('oMLX detection needs one probe');
  })).toBe(true);
});

const ACTIVITY_07 = fixtureFiles('0.7.0rc1', 'admin-api-activity.').filter(file => !file.includes('unauthorized'));
test.each([...ACTIVITY_07.map(file => ['0.7.0rc1', file]), ['0.6.4', 'admin-api-activity.generating.json']] as Array<[Version, string]>)(
  'round trip, admin session: %s %s', async (version, activity) => {
    const { adapter, time, fake } = start(version, { activity, ...activity.includes('no-pool') ? { health: 'health.healthy-null-pool.json' } : {} });
    const body = roundTrip(await read(adapter, time), activity);
    expect(body.status).toEqual({ state: 'ready', reason: null, params: {} });
    expect(body.connection.version).toBe(version);
    expect(Object.values(body.capabilities).every(item => item.basis !== 'last-observed' || item.scope === 'server')).toBe(true);
    expect(body.capabilities['server.usage'] !== undefined).toBe(version !== '0.6.4');
    expectObserverOnly(fake.calls);
  });

test('the fixtures read as oMLX reports them', async () => {
  const at = async (activity: string, health?: string) => {
    const { adapter, time } = start('0.7.0rc1', { activity, ...health ? { health } : {} });
    return roundTrip(await read(adapter, time)).runtime;
  };
  expect(await at('admin-api-activity.idle.json')).toMatchObject({ phase: 'idle', request: null,
    server: { active: 0, queued: 0, averages: { decodeTps: 27.3, prefillTps: 842.4, requestsTotal: 37, uptimeMs: 5_421_300 } },
    memory: { processBytes: 17_448_304_640, modelBytes: 16_391_340_032, ceilingBytes: 45_097_156_608, guard: 'ok' },
    residency: [{ model: 'Example-27B-4bit', phase: 'idle', source: 'runtime', active: 0, queued: 0, bytes: 16_391_340_032, contextWindowTokens: 131_072 }],
    residencyCount: 1 });
  const decode = await at('admin-api-activity.pressure-soft.json');
  expect(decode).toMatchObject({ phase: 'decode', memory: { guard: 'soft' }, server: { active: 1, queued: 0 },
    request: { model: 'Example-27B-4bit', promptTokens: 61_440, outputTokens: 588, contextWindowTokens: 131_072, contextUsedTokens: 62_028 } });
  expect(decode.request!.decodeTps).toBeCloseTo(27.46, 2);
  expect(decode.request!.elapsedMs).toBeCloseTo(21_409.12, 1);
  expect(decode.residency.map(row => [row.model, row.phase])).toEqual([['Example-27B-4bit', 'decode'], ['Example-35B-A3B-4bit', 'idle']]);
  // Two requests at once: per-request values are withheld, the counts stay.
  expect(await at('admin-api-activity.generating.json')).toMatchObject({ phase: 'processing', request: null, server: { active: 2, queued: 0 } });
  expect(await at('admin-api-activity.waiting.json')).toMatchObject({ phase: 'processing', request: null, server: { active: 2, queued: 2 } });
  expect(await at('admin-api-activity.pressure-hard.json')).toMatchObject({ memory: { guard: 'hard' }, server: { active: 1, queued: 1 } });
  const prefill = (await at('admin-api-activity.prefill.json')).residency;
  expect(prefill.map(row => [row.phase, row.prefillFraction, row.prefillTps])).toEqual([['prefill', 8192 / 24_575, 1843.7], ['prefill', 12_288 / 30_001, 2210.4]]);
  const loading = await at('admin-api-activity.loading.json');
  expect(loading).toMatchObject({ phase: 'loading', request: null, residency: [{ phase: 'loading' }] });
  expect(loading.memory.modelBytes).toBeUndefined();
  expect(loading.residency[0]!.bytes).toBeUndefined();
  // The guard is off: no footprint claim and no guard tier. /health's final_ceiling 0 means "no ceiling", not 0 bytes.
  const off = await at('admin-api-activity.guard-disabled.json', 'health.healthy-guard-off.json');
  expect(off.memory).toEqual({ modelBytes: 16_391_340_032 });
  expect(await at('admin-api-activity.no-pool.json', 'health.healthy-null-pool.json')).toMatchObject({ phase: 'not-loaded', residency: [], residencyCount: 0 });
  // The pinned preload is still running before any model is resident.
  expect((await at('admin-api-activity.no-pool.json', 'health.loading.json')).phase).toBe('loading');
  const embedding = await at('admin-api-activity.activities.json');
  expect(embedding).toMatchObject({ phase: 'processing', server: { active: 1 } });
  expect(embedding.request?.outputTokens).toBeUndefined();
});

test('capabilities follow what the reading can carry', async () => {
  const idle = start('0.7.0rc1');
  const caps = (await read(idle.adapter, idle.time)).capabilities;
  expect(Object.keys(caps).sort()).toEqual(['request.context', 'request.decodeRate', 'request.elapsed', 'request.prefillEta', 'request.prefillProgress',
    'request.prefillRate', 'request.tokens', 'server.averages', 'server.completions', 'server.memory.ceiling', 'server.memory.model',
    'server.memory.process', 'server.requests', 'server.residency', 'server.usage']);
  expect([caps['request.prefillEta']?.basis, caps['request.context']?.basis, caps['server.completions']?.basis]).toEqual(['estimate', 'derived', 'last-observed']);
  const off = start('0.7.0rc1', { activity: 'admin-api-activity.guard-disabled.json', health: 'health.healthy-guard-off.json' });
  const narrowed = (await read(off.adapter, off.time)).capabilities;
  expect([narrowed['server.memory.process'], narrowed['server.memory.ceiling'], narrowed['server.cache']]).toEqual([undefined, undefined, undefined]);
});

test('a stalled prefill turns stale after 15 s: no speed, no ETA', async () => {
  const { adapter, time, fake } = start('0.7.0rc1', { activity: 'admin-api-activity.prefill-stalled.json' });
  const first = roundTrip(await read(adapter, time)).runtime;
  expect(first.request).toMatchObject({ prefillTps: 1843.7, prefillEtaMs: 8_900, prefillFraction: 8192 / 24_575 });
  time.advance(10_000);
  expect(roundTrip(await read(adapter, time)).runtime.request?.prefillStale).toBeUndefined();
  time.advance(6_000);
  const stale = roundTrip(await read(adapter, time)).runtime;
  expect(stale.request).toMatchObject({ prefillStale: true, prefillFraction: 8192 / 24_575 });
  expect([stale.request!.prefillTps, stale.request!.prefillEtaMs]).toEqual([undefined, undefined]);
  expect(stale.residency[0]).toMatchObject({ prefillStale: true });
  // Progress moves again: fresh.
  const moved = fixture('0.7.0rc1', 'admin-api-activity.prefill-stalled.json') as { active_models: { models: Array<{ prefilling: Array<{ processed: number }> }> } };
  moved.active_models.models[0]!.prefilling[0]!.processed = 9_216;
  fake.routes[OMLX_PATHS.activity] = admin(ok(moved));
  time.advance(500);
  expect(roundTrip(await read(adapter, time)).runtime.request).toMatchObject({ prefillTps: 1843.7, prefillFraction: 9_216 / 24_575 });
});

test('a sub key falls back to /api/status: server coverage, honest status, no per-request values', async () => {
  const { adapter, time, fake, context } = start('0.7.0rc1', { api: 'api-status.busy.json' }, 'fixture-sub-key');
  const body = roundTrip(await read(adapter, time));
  expect(body.status).toEqual({ state: 'degraded', reason: 'admin_unauthorized', params: {} });
  expect(Object.values(body.capabilities).every(item => item.scope === 'server' && item.basis === 'reported')).toBe(true);
  expect(Object.keys(body.capabilities).sort()).toEqual(['server.averages', 'server.memory.ceiling', 'server.memory.model', 'server.requests', 'server.residency']);
  expect(body.runtime).toMatchObject({ phase: 'processing', request: null, server: { active: 2, queued: 1, averages: { decodeTps: 27.5, prefillTps: 876.3,
    requestsTotal: 94, uptimeMs: 9_127_700 } }, memory: { modelBytes: 16_391_340_032, ceilingBytes: 45_097_156_608 },
    residency: [{ model: 'Example-27B-4bit', phase: 'processing', source: 'runtime', contextWindowTokens: 131_072 }], residencyCount: 1 });
  expect(body.runtime.server.averages!.cacheEfficiencyFraction).toBeCloseTo(0.794, 12);
  expect(fake.calls.map(call => `${call.method} ${call.path}`)).not.toContain('GET /admin/api/activity');
  expect(fake.calls.find(call => call.path === OMLX_PATHS.status)!.headers.Authorization).toBe('Bearer fixture-sub-key');
  // The refused login is not retried on every poll, only after ADMIN_RETRY_MS; usage is not even asked for.
  time.advance(10_000);
  await read(adapter, time);
  expect(await readOmlxUsage(context, '7d')).toMatchObject({ available: false, reason: 'admin_unauthorized' });
  expect(fake.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  time.advance(ADMIN_RETRY_MS);
  roundTrip(await read(adapter, time));
  expect(fake.calls.filter(call => call.method === 'POST')).toHaveLength(2);
  // Several resident models: which one holds the request is not reported here.
  const two = fixture('0.7.0rc1', 'api-status.busy.json') as Record<string, unknown>;
  fake.routes[OMLX_PATHS.status] = ok({ ...two, models_loaded: 2, loaded_models: ['Example-27B-4bit', 'Example-35B-A3B-4bit'] });
  time.advance(1_000);
  expect(roundTrip(await read(adapter, time)).runtime.residency.map(row => row.phase)).toEqual(['unknown', 'unknown']);
  expectObserverOnly(fake.calls);
});

test('the sub-key fallback on a fresh server claims nothing it has not seen', async () => {
  const { adapter, time } = start('0.7.0rc1', { api: 'api-status.sub-key.json', health: 'health.healthy-unloaded.json' }, 'fixture-sub-key');
  const body = roundTrip(await read(adapter, time));
  // 0.0 rates and a 0.0 cache efficiency over zero tokens are "no data" (fixture report), not a measured zero.
  expect(body.runtime).toMatchObject({ phase: 'not-loaded', server: { active: 0, queued: 0, averages: { requestsTotal: 0, uptimeMs: 63_000 } },
    residency: [], residencyCount: 0, memory: { modelBytes: 0, ceilingBytes: 45_097_156_608 } });
  expect(Object.keys(body.runtime.server.averages!)).toEqual(['requestsTotal', 'uptimeMs']);
});

test('a key that neither the admin API nor /api/status accepts is an authentication failure', async () => {
  for (const [key, file] of [['fixture-other-key', 'api-status.invalid-key.json'], [null, 'api-status.unauthorized.json']] as const) {
    const { adapter, time, fake } = start('0.7.0rc1', {}, key);
    fake.routes[OMLX_PATHS.status] = from('0.7.0rc1', file, 401);
    const error = await read(adapter, time).catch(caught => caught);
    expect(error).toBeInstanceOf(HttpFailure);
    expect((error as HttpFailure).reason).toBe('authentication_failed');
    // No key: no login is attempted, and a rejected read is never retried without auth.
    expect(fake.calls.filter(call => call.method === 'POST')).toHaveLength(key === null ? 0 : 1);
    expect(fake.calls.filter(call => call.path === OMLX_PATHS.status)).toHaveLength(1);
    expectObserverOnly(fake.calls);
  }
});

test('a keyless loopback server is read without a login', async () => {
  const fake = fakeOmlx({ [OMLX_PATHS.health]: from('0.7.0rc1', 'health.healthy-loaded.json'), [OMLX_PATHS.activity]: from('0.7.0rc1', 'admin-api-activity.idle.json'),
    [OMLX_PATHS.status]: from('0.7.0rc1', 'api-status.idle.json'), [OMLX_PATHS.models]: WINDOWS });
  const time = clock(), adapter = new OmlxAdapter(contextFor(fake.fetchImpl, time, null));
  expect(roundTrip(await read(adapter, time)).status.state).toBe('ready');
  expect(fake.calls.every(call => call.method === 'GET' && !call.headers.Authorization && !call.headers.Cookie)).toBe(true);
});

test('an expired admin cookie is replaced once, not on every poll', async () => {
  const { adapter, time, fake } = start('0.7.0rc1');
  await read(adapter, time);
  let cookie = 'session-cookie-2';
  fake.routes[OMLX_PATHS.login] = () => ({ status: 200, body: { success: true }, cookie });
  fake.routes[OMLX_PATHS.activity] = request => request.headers.Cookie === `omlx_admin_session=${cookie}`
    ? from('0.7.0rc1', 'admin-api-activity.idle.json') : { status: 401, body: { detail: 'Admin authentication required' } };
  time.advance(1_000);
  expect(roundTrip(await read(adapter, time)).status.state).toBe('ready');
  time.advance(1_000);
  await read(adapter, time);
  expect(fake.calls.filter(call => call.method === 'POST')).toHaveLength(2);
  expect(fake.calls.filter(call => call.method === 'POST').every(call => JSON.parse(call.body!).remember === false)).toBe(true);
  // A fresh cookie that is refused too: the key cannot read the admin API, so the fallback serves.
  cookie = 'never-accepted';
  fake.routes[OMLX_PATHS.activity] = { status: 403, body: { detail: 'Forbidden' } };
  time.advance(1_000);
  expect(roundTrip(await read(adapter, time)).status.reason).toBe('admin_unauthorized');
});

test('side reads keep their cadence: session totals 10 s (60 s on the glance tier), context windows and health 60 s', async () => {
  for (const [tier, statusReads] of [['full', 7], ['glance', 2]] as const) {
    const { adapter, time, fake } = start('0.7.0rc1');
    for (let second = 0; second <= 60; second += 1, time.advance(1_000)) await read(adapter, time, tier);
    const count = (path: string) => fake.calls.filter(call => call.path === path).length;
    expect([count(OMLX_PATHS.activity), count(OMLX_PATHS.status), count(OMLX_PATHS.models), count(OMLX_PATHS.health), count(OMLX_PATHS.login)], tier)
      .toEqual([61, statusReads, 2, 2, 1]);
  }
});

test('failed side reads keep the last value; a failed activity read fails the read', async () => {
  const { adapter, time, fake } = start('0.7.0rc1');
  await read(adapter, time);
  fake.routes[OMLX_PATHS.status] = 'network'; fake.routes[OMLX_PATHS.models] = 'network'; fake.routes[OMLX_PATHS.health] = 'network';
  time.advance(61_000);
  const stale = roundTrip(await read(adapter, time)).runtime;
  expect(stale).toMatchObject({ server: { averages: { decodeTps: 27.3 } }, memory: { ceilingBytes: 45_097_156_608 }, residency: [{ contextWindowTokens: 131_072 }] });
  // Session totals nobody could refresh for 2 minutes are withheld, not shown as current.
  time.advance(60_000);
  const old = roundTrip(await read(adapter, time));
  expect([old.runtime.server.averages, old.capabilities['server.averages'], old.runtime.memory.ceilingBytes]).toEqual([undefined, undefined, 45_097_156_608]);
  fake.routes[OMLX_PATHS.activity] = 'network';
  time.advance(1_000);
  expect(await read(adapter, time).catch((error: HttpFailure) => error.reason)).toBe('runtime_unreachable');
  const late = start('0.7.0rc1');
  expect(await late.adapter.read({ deadline: late.time.state.mono - 1, tier: 'full', detail: false }).catch((error: HttpFailure) => error.reason))
    .toBe('runtime_unreachable');
});

test('an activity body oMLX would not send is an unsupported contract, with nothing claimed', async () => {
  const { adapter, time, fake } = start('0.7.0rc1');
  fake.routes[OMLX_PATHS.activity] = admin(ok({ active_models: { models: [true] } }));
  const body = roundTrip(await read(adapter, time));
  expect([body.status.reason, body.capabilities, body.runtime.phase, body.runtime.server]).toEqual(['unsupported_contract', {}, 'unknown', { active: null, queued: null }]);
});

test('a restart bumps the generation key', async () => {
  const { adapter, time, fake } = start('0.7.0rc1');
  // Uptime runs with the clock, as it does on a live server.
  const since = time.state.now - 5_421_300, idle = fixture('0.7.0rc1', 'api-status.idle.json') as Record<string, unknown>;
  fake.routes[OMLX_PATHS.status] = () => ok({ ...idle, uptime_seconds: (time.state.now - since) / 1000 });
  const first = await read(adapter, time);
  time.advance(10_000);
  expect((await read(adapter, time)).generationKey).toBe(first.generationKey);
  fake.routes[OMLX_PATHS.status] = status('0.7.0rc1', 'api-status.sub-key.json');   // uptime 63 s
  time.advance(10_000);
  const restarted = await read(adapter, time);
  expect(restarted.generationKey).not.toBe(first.generationKey);
  const again = time.state.now - 63_000;
  fake.routes[OMLX_PATHS.status] = () => ok({ ...idle, uptime_seconds: (time.state.now - again) / 1000 });
  time.advance(10_000);
  expect((await read(adapter, time)).generationKey).toBe(restarted.generationKey);
});

test('identity() is the /health check behind re-detection', async () => {
  const { adapter, fake } = start('0.7.0rc1');
  expect(await adapter.identity()).toBe(true);
  fake.routes[OMLX_PATHS.health] = ok({ status: 'ok' });
  expect(await adapter.identity()).toBe(false);
  expect(fake.calls.map(call => `${call.method} ${call.path}`)).toEqual(['GET /health', 'GET /health']);
});

test('a server answering the stats canary everywhere leaks none of it', async () => {
  for (const version of ['0.7.0rc1', '0.6.4'] as Version[]) {
    const canary = from(version, 'admin-api-stats.canary.json');
    const hostile = fakeOmlx({ [OMLX_PATHS.health]: from(version, version === '0.6.4' ? 'health.healthy.json' : 'health.healthy-loaded.json'),
      [OMLX_PATHS.login]: login(), [OMLX_PATHS.activity]: admin(canary), [OMLX_PATHS.status]: canary, [OMLX_PATHS.models]: canary });
    const time = clock(), adapter = new OmlxAdapter(contextFor(hostile.fetchImpl, time));
    roundTrip(await read(adapter, time), `${version} admin`);
    const sub = new OmlxAdapter(contextFor(hostile.fetchImpl, time, 'fixture-sub-key'));
    roundTrip(await read(sub, time), `${version} fallback`);
  }
  // Kernel import errors carry install paths.
  const { adapter, time } = start('0.7.0rc1', { api: 'api-status.source-install.json' }, 'fixture-sub-key');
  expect(roundTrip(await read(adapter, time)).runtime.memory.ceilingBytes).toBe(45_097_156_608);
});

test('§12.4: the memory guard tier travels with the process footprint and nowhere else', async () => {
  const { adapter, time } = start('0.7.0rc1', { activity: 'admin-api-activity.pressure-hard.json' });
  const body = roundTrip(await read(adapter, time));
  expect(body.runtime.memory).toMatchObject({ guard: 'hard', processBytes: 43_383_464_656 });
  const { 'server.memory.process': _, ...withoutProcess } = body.capabilities;
  const withheld = parseSnapshotV2({ ...body, capabilities: withoutProcess })!;
  expect([withheld.runtime.memory.guard, withheld.runtime.memory.processBytes]).toEqual([undefined, undefined]);
  expect(parseSnapshotV2({ ...body, runtime: { ...body.runtime, memory: { ...body.runtime.memory, guard: 'critical' } } })!.runtime.memory.guard).toBeUndefined();
});

test('every health and status fixture round-trips, through the admin session and through the fallback', async () => {
  for (const version of ['0.7.0rc1', '0.6.4'] as Version[]) for (const health of fixtureFiles(version, 'health.')) {
    for (const api of fixtureFiles(version, 'api-status.').filter(file => !/unauthorized|invalid/.test(file))) {
      for (const key of ['fixture-main-key', 'fixture-sub-key']) {
        const { adapter, time, fake } = start(version, { health, api }, key), name = `${version} ${health} ${api} ${key}`;
        const body = roundTrip(await read(adapter, time), name);
        expect(body.status.reason, name).toBe(key === 'fixture-sub-key' ? 'admin_unauthorized' : null);
        expect(body.connection.version, name).toBe(version);
        expectObserverOnly(fake.calls);
      }
    }
  }
});
