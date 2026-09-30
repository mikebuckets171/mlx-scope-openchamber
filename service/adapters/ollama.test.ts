import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpFailure } from '../http.ts';
import type { RuntimeReply } from '../core/adapter-v2.ts';
import { OLLAMA_PS_EVERY_MS, OLLAMA_VERSION_EVERY_MS, ollamaDescriptor, parseOllamaPs, parseOllamaVersion, rfc3339 } from './ollama.ts';
import { fakeRuntime, readContext, roundTrip, type Route } from './testing/fake-runtime.ts';

const ROOT = join(import.meta.dir, '../../tests/fixtures/ollama/0.40.0');
const json = (name: string) => JSON.parse(readFileSync(join(ROOT, name), 'utf8'));
const ok = (name: string): Route => ({ status: 200, file: name });
// Class A only: a model name (class B, incl. CANARY-MODEL-7f3a) may reach /v2/snapshot and the in-view DOM.
const CLASS_A = /CANARY-(?:PATH|HOST)|\/Users\/|parent_model|remote_host|remote_model|digest|[0-9a-f]{64}/;

const server = (routes: Record<string, Route> = {}) => {
  const runtime = fakeRuntime(ROOT, { '/api/version': ok('api-version.default.json'), '/api/ps': ok('api-ps.one-model.json'),
    '/api/tags': ok('api-tags.small.json'), ...routes });
  const adapter = ollamaDescriptor.create(runtime.context);
  const read = async () => {
    const reading = await adapter.read(readContext(runtime));
    roundTrip(reading, 'ollama');
    return reading;
  };
  return { runtime, adapter, read };
};

describe('parsers', () => {
  test('/api/version: release, pre-release and a source build (0.0.0 is still Ollama)', () => {
    expect(['default', 'rc', 'source-build'].map(name => parseOllamaVersion(json(`api-version.${name}.json`)))).toEqual(['0.40.0', '0.40.0-rc0', '0.0.0']);
    for (const body of [null, {}, { version: 40 }, { version: 'v0.40.0' }, { version: '0.40' }, { version: `0.40.0-${'x'.repeat(40)}` },
      { error: 'Unexpected endpoint or method. (GET /api/version)' }]) expect(parseOllamaVersion(body)).toBeNull();
  });

  test('Go RFC 3339 times: nanoseconds, offsets and UTC; the zero time is absent', () => {
    expect(rfc3339('2026-09-29T14:07:12.418305-07:00')).toBe(Date.UTC(2026, 8, 29, 21, 7, 12, 418));
    expect(rfc3339('2026-09-29T21:07:03.5561Z')).toBe(Date.UTC(2026, 8, 29, 21, 7, 3, 556));
    expect(rfc3339('2319-01-09T12:49:29.273080807-08:00')).toBe(Date.UTC(2319, 0, 9, 20, 49, 29, 273));
    expect(rfc3339('2026-09-29T14:07:12-07:00')).toBe(Date.UTC(2026, 8, 29, 21, 7, 12));
    for (const value of ['0001-01-01T00:00:00Z', '2026-09-29', 'yesterday', '2026-09-29T14:07:12.418305', 1_790_000_000, null]) expect(rfc3339(value), String(value)).toBeNull();
  });

  test('/api/ps rows: size, GPU-resident size, context and unload time; nothing else', () => {
    expect(parseOllamaPs(json('api-ps.none.json'))).toEqual([]);
    expect(parseOllamaPs(json('api-ps.one-model.json'))).toEqual([{ model: 'example-model:27b', phase: 'unknown', source: 'ollama-ps',
      bytes: 19_134_561_280, gpuResidentBytes: 19_134_561_280, unloadsAt: Date.UTC(2026, 8, 29, 21, 7, 12, 418), contextWindowTokens: 8_192 }]);
    expect(parseOllamaPs(json('api-ps.two-models.json')).map(row => [row.model, row.bytes, row.gpuResidentBytes, row.contextWindowTokens])).toEqual([
      ['publisher/Example-27B-4bit:latest', 16_013_516_800, 16_013_516_800, 32_768], ['example-model:27b', 19_134_561_280, 19_134_561_280, 8_192]]);
    // CPU only is 0 GPU-resident bytes, not unknown; a partial offload keeps both numbers as reported.
    expect(parseOllamaPs(json('api-ps.cpu-only.json'))[0]).toMatchObject({ model: 'hf.co/publisher/Example-8B-GGUF:Q4_K_M', gpuResidentBytes: 0, bytes: 5_582_424_064 });
    expect(parseOllamaPs(json('api-ps.partial-offload.json'))[0]).toMatchObject({ bytes: 46_170_898_432, gpuResidentBytes: 37_849_399_296 });
    // keep_alive < 0: a far-future time as reported; the panel says "kept loaded", never a 292-year countdown.
    expect(parseOllamaPs(json('api-ps.keep-alive-forever.json'))[0]?.unloadsAt).toBe(Date.UTC(2319, 0, 9, 20, 49, 29, 273));
    for (const name of readdirSync(ROOT).filter(entry => entry.startsWith('api-'))) {
      const text = JSON.stringify(parseOllamaPs(json(name)));
      expect(text, name).not.toMatch(CLASS_A);
      expect(text, name).not.toMatch(/vram|VRAM|size_vram|runner|family|quantization/);
    }
    for (const body of [null, {}, { models: null }, { models: [{ size: 1 }, 'x', null] }]) expect(parseOllamaPs(body)).toEqual([]);
  });
});

describe('detection and cadence', () => {
  const reply = (status: number, body: unknown, routeMissing = false): RuntimeReply => ({ status, body: body as RuntimeReply['body'], routeMissing });
  const [step] = ollamaDescriptor.detect;
  test('/api/version, then Ollama\'s own /api/ps', async () => {
    expect([step!.probe, step!.confidence]).toEqual(['/api/version', 'high']);
    const follows: string[] = [];
    const follow = (answer: RuntimeReply | Error) => async (path: string) => { follows.push(path); if (answer instanceof Error) throw answer; return answer; };
    for (const name of ['default', 'rc', 'source-build']) {
      expect(await step!.match(reply(200, json(`api-version.${name}.json`)), follow(reply(200, json('api-ps.none.json')))), name).toBe(true);
    }
    expect(follows).toEqual(['/api/ps', '/api/ps', '/api/ps']);
    expect(await step!.match(reply(200, json('api-version.default.json')), follow(reply(404, null)))).toBe(false);
    expect(await step!.match(reply(200, json('api-version.default.json')), follow(new HttpFailure('runtime_unreachable', 'x', 500)))).toBe(false);
    expect(await step!.match(reply(200, json('api-version.default.json')), follow(reply(200, { models: 'x' })))).toBe(false);
    expect(await step!.match(reply(200, { error: 'Unexpected endpoint or method. (GET /api/version)' }, true), follow(reply(200, json('api-ps.none.json'))))).toBe(false);
    expect(await step!.match(reply(404, null), follow(reply(200, json('api-ps.none.json'))))).toBe(false);
  });
  test('hints and cadence', () => {
    expect([ollamaDescriptor.hints('ollama', ''), ollamaDescriptor.hints('local', 'Ollama (Mac)'), ollamaDescriptor.hints('llama', 'llama-server')]).toEqual([true, true, false]);
    expect([ollamaDescriptor.cadence({ activity: true, tier: 'full', recovering: false }), ollamaDescriptor.cadence({ activity: false, tier: 'glance', recovering: false })])
      .toEqual([OLLAMA_PS_EVERY_MS, OLLAMA_PS_EVERY_MS]);
    expect(ollamaDescriptor.capabilities).toEqual([{ key: 'server.residency', basis: 'reported' }]);
  });
});

describe('the adapter', () => {
  test('residency only: GPU-resident bytes as Ollama reports them, no requests, no completions', async () => {
    const { read } = server({ '/api/ps': ok('api-ps.two-models.json') });
    const reading = await read();
    expect(reading).toMatchObject({ status: { state: 'ready', reason: null, params: {} }, identity: { version: '0.40.0' }, completions: [],
      capabilities: { 'server.residency': { scope: 'server', basis: 'reported' } } });
    expect(Object.keys(reading.capabilities)).toEqual(['server.residency']);
    expect(reading.runtime).toMatchObject({ phase: 'unknown', request: null, server: { active: null, queued: null }, residencyCount: 2,
      slots: [], catalog: [], engines: [], memory: {} });
    expect(reading.runtime.residency.map(row => row.gpuResidentBytes)).toEqual([16_013_516_800, 19_134_561_280]);
    expect(reading).not.toHaveProperty('generationKey');
    expect((await server({ '/api/ps': ok('api-ps.none.json') }).read()).runtime).toMatchObject({ phase: 'not-loaded', residency: [], residencyCount: 0 });
  });

  test('/api/version every 60 s, /api/ps on every read; never /api/tags or anything else', async () => {
    const { runtime, read, adapter } = server();
    for (let step = 0; step < 30; step += 1) { await read(); runtime.advance(OLLAMA_PS_EVERY_MS); }
    expect(new Set(runtime.log)).toEqual(new Set(['/api/version', '/api/ps']));
    expect(runtime.log.filter(path => path === '/api/ps')).toHaveLength(30);
    expect(runtime.log.filter(path => path === '/api/version')).toHaveLength(Math.ceil(30 * OLLAMA_PS_EVERY_MS / OLLAMA_VERSION_EVERY_MS));
    // identity() shares the 60 s version read.
    runtime.paths();
    expect(await adapter.identity()).toBe(true);
    expect(runtime.paths()).toEqual([]);
    runtime.advance(OLLAMA_VERSION_EVERY_MS);
    expect(await adapter.identity()).toBe(true);
    expect(runtime.paths()).toEqual(['/api/version']);
  });

  test('the version follows a reinstall; another runtime on the port is unsupported (re-detection), identity false', async () => {
    const { runtime, read, adapter } = server();
    expect((await read()).identity).toEqual({ version: '0.40.0' });
    runtime.routes['/api/version'] = ok('api-version.rc.json');
    runtime.advance(OLLAMA_VERSION_EVERY_MS);
    expect((await read()).identity).toEqual({ version: '0.40.0-rc0' });
    runtime.routes['/api/version'] = { status: 404, text: '{"detail":"Not Found"}' };
    runtime.advance(OLLAMA_VERSION_EVERY_MS);
    expect((await read()).status).toEqual({ state: 'degraded', reason: 'unsupported_contract', params: {} });
    expect(await adapter.identity()).toBe(false);
    const psGone = server({ '/api/ps': { status: 200, text: '{"error":"Unexpected endpoint or method. (GET /api/ps)"}' } });
    expect((await psGone.read()).status.reason).toBe('unsupported_contract');
  });

  test('an error body is never forwarded: a 500 is thrown by status only; 401 is authentication_failed', async () => {
    const tagsError = readFileSync(join(ROOT, 'api-tags.error-500.json'), 'utf8');
    const failing = server({ '/api/ps': { status: 500, text: tagsError } });
    const error = await failing.read().catch(caught => caught);
    expect(error).toBeInstanceOf(HttpFailure);
    expect([error.reason, error.status]).toEqual(['runtime_unreachable', 500]);
    expect(`${error.message}`).not.toMatch(/CANARY|\/Users\//);
    const keyed = server({ '/api/ps': { status: 401, text: '{"error":"unauthorized"}' } });
    expect(await keyed.read().catch(caught => [caught.reason, caught.status])).toEqual(['authentication_failed', 401]);
    const down = server({ '/api/version': 'network' });
    expect(await down.read().catch(caught => caught)).toBeInstanceOf(HttpFailure);
    // /api/version 5xx: nothing known yet cannot be read at all; a known version carries on with /api/ps.
    const flaky = server({ '/api/version': { status: 500, text: tagsError } });
    expect(await flaky.read().catch(caught => [caught.reason, caught.status, /CANARY/.test(caught.message)])).toEqual(['runtime_unreachable', 500, false]);
    const steady = server();
    await steady.read();
    steady.runtime.routes['/api/version'] = { status: 503, text: tagsError };
    steady.runtime.advance(OLLAMA_VERSION_EVERY_MS);
    expect((await steady.read()).status.state).toBe('ready');
  });

  test('round trip over every /api/version and /api/ps fixture; /api/tags fixtures are never requested', async () => {
    const versions = readdirSync(ROOT).filter(name => name.startsWith('api-version.')), rows = readdirSync(ROOT).filter(name => name.startsWith('api-ps.'));
    const served = new Set<string>();
    for (const version of versions) for (const ps of rows) {
      const { runtime, read } = server({ '/api/version': ok(version), '/api/ps': ok(ps) });
      const reading = await read();
      const { text } = roundTrip(reading, 'ollama');
      expect(text, `${version} ${ps}`).not.toMatch(CLASS_A);
      expect(text, `${version} ${ps}`).not.toMatch(/vram|VRAM/);
      expect(reading.runtime.residency.length, ps).toBe(json(ps).models.length);
      runtime.served.forEach(name => served.add(name));
    }
    expect([...served].sort()).toEqual([...versions, ...rows].sort());
    // The class B canary may reach the snapshot (in-view only); the share paths are the sanitizer's (scope-flip).
    expect(JSON.stringify((await server({ '/api/ps': ok('api-ps.canary.json') }).read()).runtime.residency)).toContain('CANARY-MODEL-7f3a');
  });

  test('more than 12 resident models: 12 rows, and the count says how many there are', async () => {
    const row = json('api-ps.one-model.json').models[0];
    const models = Array.from({ length: 15 }, (_, index) => ({ ...row, name: `example-model:${index}b`, model: `example-model:${index}b` }));
    const reading = await server({ '/api/ps': { status: 200, text: JSON.stringify({ models }) } }).read();
    expect([reading.runtime.residency.length, reading.runtime.residencyCount]).toEqual([12, 15]);
  });
});
