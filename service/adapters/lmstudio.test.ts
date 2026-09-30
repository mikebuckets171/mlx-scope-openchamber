import { afterEach, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { assertBodyLimit, classAKeys, type Json } from '../../src/contract/guards.ts';
import { honestyViolations, parseSnapshotV2, type SnapshotV2 } from '../../src/contract/snapshot.ts';
import { unitViolations } from '../../src/contract/units.ts';
import type { AdapterContextV2, AdapterReadingV2, AdapterV2, ReadContext, RuntimeReply } from '../core/adapter-v2.ts';
import { HttpFailure } from '../http.ts';
import type { Argv } from '../lib/argv.ts';
import { createConnectionActivity, type ActivityView, type ConnectionActivity, type StreamSpawn } from './lmstudio-activity.ts';
import { createLmsCli, LMS_PS_MIN_MS, LMS_RUNTIME_CACHE_MS } from './lmstudio-cli.ts';
import {
  createLmstudioAdapter, GREETING_WINDOW_MS, isGreeting, lmstudioDescriptor, lmstudioReading, modelsGenerationKey, parseV0Models, parseV1Models,
  type LmstudioDeps,
} from './lmstudio.ts';

const FIXTURES = path.join(import.meta.dir, '../../tests/fixtures/lmstudio/bionic-1.1.6');
const text = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');
const json = (name: string): unknown => JSON.parse(text(name));
const reply = (body: unknown, status = 200): RuntimeReply => ({ status, body: body as Json | null, routeMissing: false });
const GREETING = reply(json('lmstudio-greeting.ok.json')), V1 = reply(json('api-v1-models.splash.json'));
const V1_MISSING = reply(json('api-v1-models.route-missing.json'));
const v0 = (variant: 'all-not-loaded' | 'one-loaded' | 'loading' | 'empty') => reply(json(`api-v0-models.${variant}.json`));
const v1Without = () => { const body = structuredClone(json('api-v1-models.splash.json')) as { models: Array<{ loaded_instances: unknown[] }> };
  body.models[0]!.loaded_instances = []; return reply(body); };
const HOME = '/Users/fixture', LMS = `${HOME}/.lmstudio/bin/lms`, INFO = `${HOME}/.lmstudio/.internal/http-server.json`;
const MODEL = 'publisher/example-27b-splash', INSTANCE = '5c1e0a7b', NOW = 1_790_683_200_000;
const CANARY = /CANARY-(?:PROMPT|OUTPUT)-7f3a/;

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: string[] = [];
  kill(signal: NodeJS.Signals) { this.killed.push(signal); this.signalCode = signal; this.emit('exit', null, signal); return true; }
}
type Route = RuntimeReply | 'down' | Error;
const adapters: AdapterV2[] = [];
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.dispose(); });

/** One LM Studio connection on :1234 with a fake runtime, clock, exec and stream spawner. */
const harness = (routes: Record<string, Route>, options: { port?: number; ports?: { internal: number | null; rest: number | null }; id?: string;
  lms?: string | null; ps?: string; activity?: ConnectionActivity } = {}) => {
  const clock = { now: NOW, mono: 1_000_000 }, gets: string[] = [], execs: Argv[] = [], spawned: FakeChild[] = [];
  let ps = options.ps ?? text('lms-ps-json.one-loaded.txt');
  const context: AdapterContextV2 = {
    connection: { id: options.id ?? 'bionic', port: options.port ?? 1234 },
    get: async route => {
      gets.push(route);
      const answer = routes[route] ?? reply({ error: `Unexpected endpoint or method. (GET ${route})` });
      if (answer === 'down') throw new HttpFailure('runtime_unreachable', 'connect ECONNREFUSED');
      if (answer instanceof Error) throw answer;
      return structuredClone(answer);
    },
    getText: async () => ({ status: 404, text: '' }), config: {} as AdapterContextV2['config'], fetchImpl: async () => new Response(null, { status: 599 }),
    exec: async () => { throw new Error('lms must never run through context.exec (it drops the no-wake env)'); },
    now: () => clock.now, monotonic: () => clock.mono, timeoutMs: 3_000, budgetMs: 4_000,
  };
  const exec = async (argv: Argv) => { execs.push(argv); return argv.args[0] === 'ps' ? ps : text('lms-runtime-ls.bionic-splash.txt'); };
  const lms = options.lms === undefined ? LMS : options.lms;
  const spawn: StreamSpawn = () => { const child = new FakeChild(); spawned.push(child); return child; };
  const deps: LmstudioDeps = { home: HOME, lms, serverInfoPath: INFO, readPorts: () => options.ports ?? { internal: 41_343, rest: 1234 },
    cli: createLmsCli({ exec, lms, serverInfoPath: INFO, now: context.now }),
    activity: options.activity ?? createConnectionActivity({ lms, serverInfoPath: INFO, now: context.now, home: HOME, spawn, idleStopMs: 5_000 }) };
  const adapter = createLmstudioAdapter(context, deps);
  adapters.push(adapter);
  const read = (tier: ReadContext['tier'] = 'full', detail = false) => adapter.read({ deadline: clock.mono + 4_000, tier, detail });
  const advance = (ms: number) => { clock.now += ms; clock.mono += ms; };
  const record = (content: string, level = 'info') => { spawned.at(-1)!.stdout.write(`${JSON.stringify({ timestamp: 1, data: { type: 'server.log', content, level } })}\n`); };
  return { adapter, routes, gets, execs, spawned, read, advance, record, setPs: (next: string) => { ps = next; } };
};
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const BIONIC = (variant: Parameters<typeof v0>[0] = 'one-loaded') => ({ '/lmstudio-greeting': GREETING, '/api/v1/models': V1, '/api/v0/models': v0(variant) });

/** What svc-2b's compose will build around a reading; the round trip must lose nothing and add nothing. */
const bodyOf = (reading: AdapterReadingV2): SnapshotV2 => ({
  contractVersion: 2, serverNow: reading.at, service: { version: '2.0.0', instance: INSTANCE },
  connection: { id: 'bionic', label: 'Splash (Bionic)', runtime: 'lmstudio', ...reading.identity, generation: 3, choices: [],
    detection: { basis: 'probe', confidence: 'high', probe: '/lmstudio-greeting' } },
  status: reading.status, capabilities: reading.capabilities, runtime: reading.runtime, host: null,
  completions: { instance: INSTANCE, cursor: reading.completions.length, reset: false,
    items: reading.completions.map((draft, index) => ({ ...draft, seq: index + 1, host: {} })) },
  marksHead: 0, alerts: [], alertLog: [], lease: { leader: true, epoch: 1, ttlMs: 12_000, leaderSurface: 'panel' }, nextPollMs: 2_000,
});
const expectRoundTrip = (reading: AdapterReadingV2, name = 'reading'): SnapshotV2 => {
  const body = bodyOf(reading), wire = assertBodyLimit(body);
  expect(parseSnapshotV2(JSON.parse(wire)), name).toEqual(JSON.parse(wire));
  expect([honestyViolations(body), unitViolations(body), classAKeys(JSON.parse(wire))], name).toEqual([[], [], []]);
  expect(wire, name).not.toMatch(CANARY);
  // Paths lms reports (`path`, `indexedModelIdentifier`) never leave: they are the only capitalised ids in the corpus.
  expect(wire, name).not.toContain('Example-27B-Splash');
  expect(JSON.stringify(reading.generationKey ?? '')).not.toContain('example');
  return body;
};

test('descriptor: greeting plus the inventory route identifies LM Studio; hints, cadence and capabilities', async () => {
  const d = lmstudioDescriptor, step = d.detect[0]!;
  expect([d.id, d.detect.length, step.probe, step.confidence, d.identityEveryMs]).toEqual(['lmstudio', 1, '/lmstudio-greeting', 'high', 60_000]);
  expect([d.hints('bionic', ''), d.hints('x', 'LM Studio'), d.hints('omlx', 'Local oMLX')]).toEqual([true, true, false]);
  const follow = (answer: Route) => async () => { if (answer === 'down') throw new HttpFailure('runtime_unreachable', 'down'); if (answer instanceof Error) throw answer; return answer; };
  expect(await step.match(GREETING, follow(V1))).toBe(true);
  expect(await step.match(GREETING, follow(V1_MISSING))).toBe(true);                     // LM Studio before 0.4: v0 only
  expect(await step.match(GREETING, follow(reply(null, 401)))).toBe(true);               // authentication on: still LM Studio
  expect(await step.match(GREETING, follow(new HttpFailure('authentication_failed', 'key', 403)))).toBe(true);
  expect(await step.match(GREETING, follow(reply({ data: [] })))).toBe(false);
  expect(await step.match(GREETING, follow('down'))).toBe(false);
  for (const greeting of [reply({ lmstudio: 'true' }), reply({ lmstudio: true }, 404), V1_MISSING, reply(null, 404)]) {
    expect(await step.match(greeting, follow(V1))).toBe(false);
  }
  expect([d.cadence({ activity: true, tier: 'full', recovering: false }), d.cadence({ activity: false, tier: 'full', recovering: false }),
    d.cadence({ activity: false, tier: 'glance', recovering: false })]).toEqual([1_000, 2_000, 3_000]);
  expect(d.capabilities.map(item => item.key).sort()).toEqual(['request.context', 'request.elapsed', 'request.prefillProgress', 'server.averages',
    'server.catalog', 'server.completions', 'server.engines', 'server.requests', 'server.residency']);
  expect(isGreeting(null)).toBe(false);
});

test('inventories: v1 and v0 bodies, the load-state generation key, and unsupported shapes', () => {
  const v1 = parseV1Models(json('api-v1-models.splash.json'))!;
  expect(v1.loaded).toEqual([{ id: MODEL, key: MODEL, contextWindowTokens: 262_144 }]);
  expect(v1.catalog).toEqual([
    { name: MODEL, format: 'splash', loaded: true, contextWindowTokens: 262_144, vision: true },
    { name: 'example-35b-a3b-splash', format: 'splash', loaded: false, contextWindowTokens: 262_144, vision: true },
    { name: 'publisher/example-27b-4bit', format: 'mlx', loaded: false, contextWindowTokens: 131_072, vision: false },
    { name: 'publisher/example-8b-gguf', format: 'gguf', loaded: false, contextWindowTokens: 131_072, vision: false },
    { name: 'text-embedding-example-embed-v1.5', format: 'gguf', loaded: false, contextWindowTokens: 2_048 },
  ]);
  expect([v1.countKnown, v1.splash]).toEqual([true, true]);
  const loading = parseV0Models(json('api-v0-models.loading.json'))!;
  expect([loading.loaded, loading.loading, loading.countKnown]).toEqual([[], [MODEL], true]);
  expect(loading.catalog[0]).toEqual({ name: MODEL, format: 'splash', loaded: null, contextWindowTokens: 262_144, vision: true });
  expect(loading.catalog[4]).toEqual({ name: 'text-embedding-example-embed-v1.5', format: 'gguf', loaded: false, contextWindowTokens: 2_048 });
  expect(parseV0Models(json('api-v0-models.one-loaded.json'))!.loaded).toEqual([{ id: MODEL, key: MODEL, contextWindowTokens: null }]);
  expect(parseV0Models(json('api-v0-models.empty.json'))).toEqual({ catalog: [], loaded: [], loading: [], countKnown: true, splash: false });
  const keys = (['all-not-loaded', 'loading', 'one-loaded', 'empty'] as const).map(variant => modelsGenerationKey(json(`api-v0-models.${variant}.json`)));
  expect(new Set(keys).size).toBe(4);
  const reordered = structuredClone(json('api-v0-models.one-loaded.json')) as { data: unknown[] };
  reordered.data.reverse();
  expect(modelsGenerationKey(reordered)).toBe(keys[2]!);
  for (const body of [null, { data: [] }, { models: [] }, { object: 'list' }, json('api-v1-models.splash.json')]) expect(modelsGenerationKey(body)).toBeNull();
  for (const body of [null, {}, { models: 'x' }, { models: [{ type: 'image', key: 'x' }] }]) expect(parseV1Models(body)).toBeNull();
  for (const body of [null, { data: [] }, { object: 'list', data: {} }, { object: 'list', data: [{ id: 'x', type: 'tts' }] }]) expect(parseV0Models(body)).toBeNull();
  // A row that cannot be read is skipped and makes the loaded count unknown; an unknown state is not "not loaded".
  const partial = parseV1Models({ models: [...(json('api-v1-models.splash.json') as { models: unknown[] }).models, { type: 'llm' }] })!;
  expect([partial.catalog.length, partial.countKnown]).toEqual([5, false]);
  expect(parseV0Models({ object: 'list', data: [{ id: 'm', type: 'llm', state: 'unloading' }] })).toMatchObject({ countKnown: false, catalog: [{ loaded: null }] });
});

test('Bionic, full tier: inventory, lms ps residency, identity and one stream; lms never runs through context.exec', async () => {
  const h = harness(BIONIC());
  const reading = await h.read();
  expect(h.gets).toEqual(['/lmstudio-greeting', '/api/v1/models', '/api/v0/models']);
  expect(h.execs.map(argv => [argv.file, ...argv.args, argv.env?.LMS_API_SERVER_INFO_PATH])).toEqual([[LMS, 'ps', '--json', '--port', '41343', INFO]]);
  expect(h.spawned).toHaveLength(1);
  expect(reading).toMatchObject({ at: NOW, status: { state: 'ready', reason: null }, identity: { engine: 'splash', host: 'bionic' }, completions: [] });
  expect(reading.generationKey).toBe(modelsGenerationKey(json('api-v0-models.one-loaded.json'))!);
  // The stream has not delivered a record yet: nothing about requests is claimed.
  expect(reading.runtime).toMatchObject({ phase: 'unknown', request: null, server: { active: null, queued: null }, residencyCount: 1, engines: [], slots: [] });
  expect(reading.runtime.residency).toEqual([{ model: MODEL, phase: 'unknown', source: 'lms-ps', bytes: 18_683_107_738, contextWindowTokens: 262_144 }]);
  expect(reading.runtime.catalog.map(model => model.name)[0]).toBe(MODEL);
  expect(Object.keys(reading.capabilities).sort()).toEqual(['server.catalog', 'server.residency']);
  expectRoundTrip(reading);
  h.record('[2026-09-29 12:00:00][INFO] Returning 5 models from v1 API');
  await tick();
  h.advance(2_000);
  const idle = await h.read();
  expect(idle.runtime).toMatchObject({ phase: 'idle', server: { active: 0, queued: null } });
  expect(idle.runtime.residency[0]).toMatchObject({ phase: 'idle', active: 0 });
  expect(idle.capabilities).toMatchObject({ 'server.requests': { basis: 'observed' }, 'request.elapsed': { basis: 'observed' },
    'request.prefillProgress': { basis: 'reported' }, 'server.completions': { basis: 'reported' } });
  expectRoundTrip(idle);
  expect(h.execs).toHaveLength(1);
  expect(h.spawned).toHaveLength(1);
});

test('a request on the stream: live phase, prefill progress and elapsed time, then an exact completion', async () => {
  const h = harness(BIONIC());
  await h.read();
  for (const line of text('lms-log-stream-server.sensitive-on.txt').split('\n').slice(0, 4)) h.spawned[0]!.stdout.write(`${line}\n`);
  await tick();
  h.advance(1_500);
  const prefill = await h.read();
  expect(prefill.runtime.phase).toBe('prefill');
  expect(prefill.runtime.request).toEqual({ model: MODEL, elapsedMs: 1_500, prefillFraction: 0, contextWindowTokens: 262_144 });
  expect(prefill.runtime.residency[0]).toMatchObject({ phase: 'prefill', active: 1, prefillFraction: 0 });
  expectRoundTrip(prefill, 'prefill');
  for (const line of text('lms-log-stream-server.sensitive-on.txt').split('\n').slice(4)) h.spawned[0]!.stdout.write(`${line}\n`);
  await tick();
  h.advance(1_500);
  const done = await h.read();
  expect(done.runtime).toMatchObject({ phase: 'idle', request: null, server: { active: 0, averages: { decodeTps: 79.6, cacheEfficiencyFraction: 0 } } });
  expect(done.completions).toEqual([{ finishedAt: NOW + 1_500, startedAt: NOW, model: MODEL, basis: 'reported', overlapped: false,
    promptTokens: 640, cachedTokens: 0, outputTokens: 1_050, ttftMs: 900, decodeTps: 79.6 }]);
  expect(done.capabilities['server.averages']).toEqual({ scope: 'server', basis: 'derived' });
  const body = expectRoundTrip(done, 'done');
  expect(body.completions.items).toHaveLength(1);
  expect((await h.read()).completions).toEqual([]);
});

test('overlapping requests: a busy phase with no single request, and every span overlapped', async () => {
  const view: ActivityView = { healthy: true, active: 2, request: null, models: [{ model: MODEL, active: 2, phase: 'decode', fraction: null }],
    averages: {}, seen: 3, completions: [{ finishedAt: NOW, startedAt: null, model: null, basis: 'reported', overlapped: true, outputTokens: 5 }] };
  const activity: ConnectionActivity = { touch() {}, view: () => structuredClone(view), dispose() {} };
  const h = harness(BIONIC(), { activity });
  const reading = await h.read();
  expect(reading.runtime).toMatchObject({ phase: 'processing', request: null, server: { active: 2 } });
  expect(reading.runtime.residency[0]).toMatchObject({ phase: 'processing', active: 2 });
  expect(reading.runtime.residency[0]).not.toHaveProperty('prefillFraction');
  expect(reading.completions).toEqual(view.completions);
  expectRoundTrip(reading);
});

test('lms ps runs again only for a load-state change, at most once a minute, and residency follows the REST inventory', async () => {
  const h = harness({ '/lmstudio-greeting': GREETING, '/api/v1/models': v1Without(), '/api/v0/models': v0('all-not-loaded') }, { ps: '[]\n' });
  const empty = await h.read();
  expect(empty.runtime).toMatchObject({ phase: 'not-loaded', residency: [], residencyCount: 0 });
  expectRoundTrip(empty);
  h.advance(10_000);
  h.routes['/api/v0/models'] = v0('loading');
  const loading = await h.read();
  expect(loading.runtime).toMatchObject({ phase: 'loading', residency: [{ model: MODEL, phase: 'loading', source: 'runtime' }], residencyCount: 1 });
  expect(loading.generationKey).not.toBe(empty.generationKey);
  expect(h.execs).toHaveLength(1);                                   // changed, but inside the 60 s floor
  h.advance(10_000);
  h.routes['/api/v0/models'] = v0('one-loaded');
  h.routes['/api/v1/models'] = V1;
  const loaded = await h.read();
  // Loaded per REST, not in the (older, empty) lms ps rows: a runtime row without a size until ps catches up.
  expect(loaded.runtime.residency).toEqual([{ model: MODEL, phase: 'unknown', source: 'runtime', contextWindowTokens: 262_144 }]);
  expectRoundTrip(loaded);
  h.setPs(text('lms-ps-json.one-loaded.txt'));
  h.advance(LMS_PS_MIN_MS - 20_000);
  expect((await h.read()).runtime.residency[0]).toMatchObject({ source: 'lms-ps', bytes: 18_683_107_738 });
  expect(h.execs).toHaveLength(2);
  // Unloaded while the lms ps rows still list it: the REST inventory wins, so the row goes at once.
  h.advance(5_000);
  h.routes['/api/v0/models'] = v0('all-not-loaded');
  h.routes['/api/v1/models'] = v1Without();
  expect((await h.read()).runtime).toMatchObject({ phase: 'not-loaded', residency: [], residencyCount: 0 });
  expect(h.execs).toHaveLength(2);
});

test('glance tier never runs lms one-shots; the stream still serves live state; detail needs the full tier', async () => {
  const h = harness(BIONIC());
  const glance = await h.read('glance', true);
  expect(h.execs).toEqual([]);
  expect(h.spawned).toHaveLength(1);
  expect(glance.runtime.residency).toEqual([{ model: MODEL, phase: 'unknown', source: 'runtime', contextWindowTokens: 262_144 }]);
  expect(glance.runtime.engines).toEqual([]);
  await h.read('full');
  h.advance(3_000);
  // A glance read reuses the last lms ps rows without spawning.
  expect((await h.read('glance')).runtime.residency[0]).toMatchObject({ source: 'lms-ps', bytes: 18_683_107_738 });
  expect(h.execs).toHaveLength(1);
});

test('the Server tab: lms runtime ls with detail=server, cached 10 minutes, as the Engines card', async () => {
  const h = harness(BIONIC());
  const detail = await h.read('full', true);
  expect(h.execs.map(argv => argv.args.slice(0, 2))).toEqual([['ps', '--json'], ['runtime', 'ls']]);
  expect(detail.runtime.engines).toEqual([
    { name: 'llama.cpp', version: '2.41.0', selected: true, format: 'gguf' }, { name: 'mlx-llm-nax', version: '1.9.0', selected: true, format: 'mlx' },
    { name: 'splash', version: '0.0.5', selected: true, format: 'yuzu' }, { name: 'llama.cpp', version: '2.39.2', selected: false, format: 'gguf' },
    { name: 'mlx-llm', version: '1.9.0', selected: false, format: 'mlx' }]);
  expect(detail.capabilities['server.engines']).toEqual({ scope: 'server', basis: 'reported' });
  expectRoundTrip(detail);
  h.advance(5_000);
  expect((await h.read('full', false)).runtime.engines).toEqual([]);
  h.advance(LMS_RUNTIME_CACHE_MS - 10_000);
  expect((await h.read('full', true)).runtime.engines).toHaveLength(5);
  expect(h.execs.filter(argv => argv.args[0] === 'runtime')).toHaveLength(1);
  h.advance(5_000);
  await h.read('full', true);
  expect(h.execs.filter(argv => argv.args[0] === 'runtime')).toHaveLength(2);
});

test('no greeting within 10 s: lms_unavailable, and no lms spawn of any kind', async () => {
  for (const greeting of [reply(null, 404), V1_MISSING, reply({ lmstudio: false }), reply(null, 500)]) {
    const h = harness({ ...BIONIC(), '/lmstudio-greeting': greeting });
    const reading = await h.read('full', true);
    expect(reading.status).toEqual({ state: 'degraded', reason: 'lms_unavailable', params: {} });
    expect(reading.runtime.catalog).toHaveLength(5);
    expect([h.execs, h.spawned]).toEqual([[], []]);
    expectRoundTrip(reading);
  }
});

test('the greeting is re-checked every 5 s; once it stops answering, lms stops 10 s after the last one', async () => {
  const h = harness(BIONIC());
  await h.read();
  h.advance(2_000); await h.read();
  expect(h.gets.filter(route => route === '/lmstudio-greeting')).toHaveLength(1);
  h.advance(3_000); await h.read();
  expect(h.gets.filter(route => route === '/lmstudio-greeting')).toHaveLength(2);
  h.routes['/lmstudio-greeting'] = reply(null, 503);
  h.advance(GREETING_WINDOW_MS);
  h.spawned[0]!.emit('exit', 1, null);
  h.advance(LMS_PS_MIN_MS * 4);
  const reading = await h.read('full', true);
  expect(reading.status.reason).toBe('lms_unavailable');
  expect([h.execs.length, h.spawned.length]).toEqual([1, 1]);
});

test('an unreachable runtime is a thrown read: zero lms spawns, and an ended stream is never restarted', async () => {
  const down = harness({ '/lmstudio-greeting': 'down', '/api/v1/models': 'down', '/api/v0/models': 'down' });
  for (let index = 0; index < 3; index += 1) { await expect(down.read('full', true)).rejects.toThrow('ECONNREFUSED'); down.advance(LMS_PS_MIN_MS); }
  expect([down.execs, down.spawned]).toEqual([[], []]);
  const gone = harness(BIONIC());
  await gone.read();
  gone.routes['/lmstudio-greeting'] = 'down';
  gone.spawned[0]!.emit('exit', 0, null);                              // the app quit; lms exited with it
  for (let index = 0; index < 5; index += 1) { gone.advance(30_000); await expect(gone.read()).rejects.toThrow(); }
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(gone.spawned).toHaveLength(1);
});

test('only the connection on this Mac\'s LM Studio REST port uses lms', async () => {
  for (const options of [{ port: 1235 }, { ports: { internal: 41_343, rest: null } }, { ports: { internal: null, rest: 1234 } }, { lms: null }]) {
    const h = harness(BIONIC(), options);
    const reading = await h.read('full', true);
    expect(reading.status.state).toBe('ready');
    expect(reading.runtime.residency).toEqual([{ model: MODEL, phase: 'unknown', source: 'runtime', contextWindowTokens: 262_144 }]);
    expect([h.execs, h.spawned]).toEqual([[], []]);
    expectRoundTrip(reading);
  }
});

test('LM Studio before 0.4: the 200 route-missing body falls back to v0 for good', async () => {
  const h = harness({ '/lmstudio-greeting': GREETING, '/api/v1/models': V1_MISSING, '/api/v0/models': v0('one-loaded') }, { id: 'lmstudio' });
  const reading = await h.read();
  expect(reading.status.state).toBe('ready');
  expect(reading.runtime.catalog[0]).toEqual({ name: MODEL, format: 'splash', loaded: true, contextWindowTokens: 262_144, vision: true });
  expect(reading.runtime.residency).toEqual([{ model: MODEL, phase: 'unknown', source: 'lms-ps', bytes: 18_683_107_738, contextWindowTokens: 262_144 }]);
  expectRoundTrip(reading);
  h.advance(2_000);
  await h.read();
  expect(h.gets.filter(route => route === '/api/v1/models')).toHaveLength(1);
  const plain = harness({ '/lmstudio-greeting': GREETING, '/api/v1/models': reply(null, 404), '/api/v0/models': v0('empty') }, { id: 'local' });
  expect(await plain.read()).toMatchObject({ status: { state: 'ready' }, identity: {}, runtime: { phase: 'not-loaded', residencyCount: 0 } });
});

test('a key the server rejects is authentication_failed and never falls back to v0; other shapes are unsupported', async () => {
  for (const rejected of [reply(null, 401), new HttpFailure('authentication_failed', 'key', 403)]) {
    const h = harness({ ...BIONIC(), '/api/v1/models': rejected });
    const reading = await h.read();
    expect(reading).toMatchObject({ status: { state: 'failing', reason: 'authentication_failed' }, capabilities: {}, completions: [] });
    expect(h.gets).not.toContain('/api/v0/models');
    expect(h.spawned).toEqual([]);
    expectRoundTrip(reading);
  }
  const odd = harness({ ...BIONIC(), '/api/v1/models': reply({ models: [{ type: 'image', key: 'x' }] }) });
  expect((await odd.read()).status).toEqual({ state: 'degraded', reason: 'unsupported_contract', params: {} });
  const neither = harness({ '/lmstudio-greeting': GREETING, '/api/v1/models': V1_MISSING, '/api/v0/models': V1_MISSING });
  expect((await neither.read()).status.reason).toBe('unsupported_contract');
  const broken = harness({ ...BIONIC(), '/api/v1/models': reply(null, 500) });
  await expect(broken.read()).rejects.toThrow('HTTP 500');
  // A host without /api/v0 still gets a generation key from its loaded instances.
  const noV0 = harness({ '/lmstudio-greeting': GREETING, '/api/v1/models': V1, '/api/v0/models': reply(null, 404) });
  expect((await noV0.read()).generationKey).toMatch(/^v1\./);
});

test('stock LM Studio: no Splash engine, so no reply capability until a summary actually arrives', () => {
  const inventory = parseV1Models({ models: (json('api-v1-models.splash.json') as { models: Array<Record<string, unknown>> }).models
    .map(model => ({ ...model, format: model.format === 'splash' ? 'mlx' : model.format })) })!;
  const view: ActivityView = { healthy: true, active: 0, request: null, models: [], averages: {}, seen: 0, completions: [] };
  const sample = { at: NOW, connectionId: 'lmstudio', inventory, generationKey: null, ps: null, engines: null, activity: view, lmsBlocked: false };
  const stock = lmstudioReading(sample);
  expect(stock.identity).toEqual({});
  expect(stock.capabilities['server.completions']).toBeUndefined();
  expect(stock.capabilities['server.requests']).toEqual({ scope: 'server', basis: 'observed' });
  expect(lmstudioReading({ ...sample, activity: { ...view, seen: 1 } }).capabilities['server.completions']).toBeDefined();
  expect(lmstudioReading({ ...sample, connectionId: 'my-bionic' }).identity).toEqual({ host: 'bionic' });
  expectRoundTrip(stock);
});

test('identity() is the greeting; dispose stops the stream', async () => {
  const h = harness(BIONIC());
  expect(await h.adapter.identity()).toBe(true);
  await h.read();
  h.routes['/lmstudio-greeting'] = reply({ error: 'Unexpected endpoint or method. (GET /lmstudio-greeting)' });
  expect(await h.adapter.identity()).toBe(false);
  h.routes['/lmstudio-greeting'] = 'down';
  await expect(h.adapter.identity()).rejects.toThrow();
  h.adapter.dispose();
  expect(h.spawned[0]!.killed).toEqual(['SIGTERM']);
});

test('a spawn slower than the read deadline is not waited for; its rows arrive on the next read', async () => {
  const clock = { mono: 0 };
  let release: (value: string | null) => void = () => {};
  const exec = (_argv: Argv) => new Promise<string | null>(resolve => { release = resolve; });
  const context = { connection: { id: 'bionic', port: 1234 }, now: () => NOW, monotonic: () => clock.mono, budgetMs: 30, timeoutMs: 30,
    get: async (route: string) => structuredClone(BIONIC()[route as keyof ReturnType<typeof BIONIC>]),
    exec: async () => null } as unknown as AdapterContextV2;
  const quiet: ConnectionActivity = { touch() {}, view: () => null, dispose() {} };
  const adapter = createLmstudioAdapter(context, { home: HOME, lms: LMS, serverInfoPath: INFO, readPorts: () => ({ internal: 41_343, rest: 1234 }),
    cli: createLmsCli({ exec, lms: LMS, serverInfoPath: INFO, now: () => NOW }), activity: quiet });
  const first = await adapter.read({ deadline: 30, tier: 'full', detail: false });
  expect(first.runtime.residency[0]).toMatchObject({ source: 'runtime' });
  release(text('lms-ps-json.one-loaded.txt'));
  await tick();
  expect((await adapter.read({ deadline: 30, tier: 'full', detail: false })).runtime.residency[0]).toMatchObject({ source: 'lms-ps' });
  expect((await adapter.read({ deadline: -1, tier: 'full', detail: false })).runtime.residency[0]).toMatchObject({ source: 'lms-ps' });
});
