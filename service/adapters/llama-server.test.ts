import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpFailure } from '../http.ts';
import { parsePrometheus } from '../lib/prometheus.ts';
import type { AdapterReadingV2, AdapterV2, RuntimeReply } from '../core/adapter-v2.ts';
import {
  LLAMA_METRICS, LLAMA_METRICS_EVERY_MS, LLAMA_PROPS_EVERY_MS, llamaDescriptor, llamaPolicy, llamaRates, llamaRestarted, llamaSpeculative, parseLlamaProps,
  parseSlots, readSlots, slotCompletion, SlotWatch, type LlamaProps,
} from './llama-server.ts';
import { EPOCH, fakeRuntime, readContext, roundTrip, type FakeRuntime, type Route } from './testing/fake-runtime.ts';

const ROOT = join(import.meta.dir, '../../tests/fixtures/llama-server');
type Build = 'b10519' | 'b6700';
const file = (build: Build, name: string) => readFileSync(join(ROOT, build, name), 'utf8');
const json = (build: Build, name: string) => JSON.parse(file(build, name));
const metrics = (build: Build, name: string) => parsePrometheus(file(build, name), { allow: name => LLAMA_METRICS.has(name) });
const ok = (name: string): Route => ({ status: 200, file: name });
const status = (code: number, name: string): Route => ({ status: code, file: name });
const CANARIES = /CANARY|\/Users\/|fixture\/models|generation_prompt|chat_template|\{#-/;

/** A llama-server with every route answering from `build`'s fixtures; tests swap routes between reads. */
const server = (build: Build, routes: Record<string, Route> = {}) => {
  const runtime = fakeRuntime(join(ROOT, build), { '/health': ok('health.ok.json'), '/props': ok('props.normal.json'),
    '/metrics': ok('metrics.idle.txt'), '/slots': ok('slots.all-idle.json'), ...routes });
  const adapter = llamaDescriptor.create(runtime.context);
  const read = async (tier: 'full' | 'glance' = 'full') => {
    const reading = await adapter.read(readContext(runtime, tier));
    roundTrip(reading, 'llama-server');
    return reading;
  };
  return { runtime, adapter, read };
};
const texts = (reading: AdapterReadingV2) => JSON.stringify(reading);
const withProps = (build: Build, name: string, change: (body: Record<string, unknown>) => void): Route => {
  const body = json(build, name); change(body);
  return { status: 200, text: JSON.stringify(body) };
};
const slotsText = (build: Build, name: string, change: (slots: Array<Record<string, any>>) => void): Route => {
  const body = json(build, name); change(body);
  return { status: 200, text: JSON.stringify(body) };
};

describe('/props (bare, numeric/boolean allowlist)', () => {
  test('both builds: build number, sleep support, endpoints, context, and the model name without its path', () => {
    const b10519 = parseLlamaProps(json('b10519', 'props.normal.json'));
    expect(b10519).toEqual({ build: 10_519, router: false, sleeping: false, metrics: true, slots: true, totalSlots: 4, contextWindowTokens: 32_768,
      model: 'example-27b-q4.gguf', vision: false, audio: false });
    expect(parseLlamaProps(json('b6700', 'props.normal.json'))).toEqual({ build: 6_700, router: false, sleeping: null, metrics: true, slots: true,
      totalSlots: 4, contextWindowTokens: 8_192, model: 'example-27b-q4.gguf', vision: false, audio: false });
    expect(parseLlamaProps(json('b10519', 'props.sleeping.json'))?.sleeping).toBe(true);
    expect(parseLlamaProps(json('b10519', 'props.no-metrics.json'))?.metrics).toBe(false);
    expect(parseLlamaProps(json('b10519', 'props.router.json'))).toMatchObject({ router: true, model: null, totalSlots: null });
    for (const name of ['props.normal.json', 'props.sleeping.json', 'props.no-metrics.json']) {
      expect(JSON.stringify(parseLlamaProps(json('b10519', name)))).not.toMatch(CANARIES);
    }
    for (const body of [null, [], {}, { build_info: 7 }, json('b10519', 'props.unauthorized-401.json')]) expect(parseLlamaProps(body)).toBeNull();
  });

  test('detection: /props with build_info and total_slots; a router or another runtime is not llama-server', async () => {
    const [high, low] = llamaDescriptor.detect;
    const reply = (status: number, body: unknown, routeMissing = false): RuntimeReply => ({ status, body: body as RuntimeReply['body'], routeMissing });
    const follow = async () => { throw new Error('llama-server detection makes no second GET'); };
    for (const build of ['b10519', 'b6700'] as const) {
      for (const name of ['props.normal.json', 'props.no-metrics.json']) expect(await high!.match(reply(200, json(build, name)), follow), `${build} ${name}`).toBe(true);
      expect(await low!.match(reply(401, json(build, 'props.unauthorized-401.json')), follow)).toBe(true);
    }
    expect(await high!.match(reply(200, json('b10519', 'props.sleeping.json')), follow)).toBe(true);
    expect(await high!.match(reply(200, json('b10519', 'props.router.json')), follow)).toBe(false);
    expect([high!.probe, high!.confidence, low!.probe, low!.confidence]).toEqual(['/props', 'high', '/props', 'low']);
    const others = [{ status: 'healthy', engine_pool: { model_count: 1 } }, { ready: true }, { version: '0.40.0' }, { data: [] },
      { error: 'Unexpected endpoint or method. (GET /props)' }, { detail: 'Not authenticated' }, { error: { code: 401, message: 'x' } }];
    for (const body of others) {
      expect(await high!.match(reply(200, body), follow)).toBe(false);
      expect(await low!.match(reply(401, body), follow)).toBe(false);
    }
    expect(await high!.match(reply(200, json('b10519', 'props.normal.json'), true), follow)).toBe(false);
  });

  test('hints name llama.cpp servers, never Ollama', () => {
    for (const [id, name] of [['llama', 'llama-server'], ['llamacpp', ''], ['local', 'llama.cpp (4B)'], ['llama_server', 'x']]) expect(llamaDescriptor.hints(id!, name!), id).toBe(true);
    for (const [id, name] of [['ollama', 'Ollama'], ['ollama-server', ''], ['omlx', 'oMLX'], ['llama', 'Llama 3']]) expect(llamaDescriptor.hints(id!, name!), id).toBe(false);
  });
});

describe('the S7b rule', () => {
  const props = (build: number | null, sleeping: boolean | null, metrics = true, slots = true, router = false): LlamaProps =>
    ({ build, router, sleeping, metrics, slots, totalSlots: 4, contextWindowTokens: 4096, model: 'm', vision: null, audio: null });
  test.each([
    // build, is_sleeping, endpoint_metrics → sleep-capable, /metrics, /slots, wakes
    [6_000, null, true, false, true, false, false],        // before /slots
    [6_337, null, true, false, true, true, false],
    [6_700, null, false, false, false, true, false],       // cannot sleep: /slots needs no /metrics
    [7_491, null, true, false, true, true, false],
    [7_492, false, true, true, false, true, true],         // /metrics would wake it
    [10_518, true, true, true, false, true, true],
    [10_519, false, true, true, true, true, false],        // /metrics answered from a cache while asleep
    [10_519, true, true, true, true, true, false],
    [10_519, false, false, true, false, true, false],      // started without --metrics
    [null, null, true, false, true, false, false],         // unknown build without is_sleeping: /metrics, never /slots
    [null, false, true, true, false, false, true],         // unknown build that can sleep: nothing that might wake it
    [8_000, null, true, true, true, true, false],          // "or without is_sleeping" (S7b rule 2), still gated as sleep-capable
  ] as const)('b%p is_sleeping=%p metrics=%p', (build, sleeping, endpoint, sleepCapable, metricsOk, slotsOk, wakes) => {
    expect(llamaPolicy(props(build, sleeping, endpoint))).toEqual({ sleepCapable, metrics: metricsOk, slots: slotsOk, wakes });
  });
  test('router mode reads neither /metrics nor /slots; --no-slots turns /slots off', () => {
    expect(llamaPolicy(props(10_519, false, true, true, true))).toMatchObject({ metrics: false, slots: false });
    expect(llamaPolicy(props(10_519, false, true, false))).toMatchObject({ metrics: true, slots: false });
  });

  test('b10519 idle: /metrics shows no work, so /slots is never read', async () => {
    const { runtime, read } = server('b10519');
    const first = await read();
    expect(runtime.paths()).toEqual(['/health', '/props', '/metrics']);
    expect(first).toMatchObject({ status: { state: 'ready', reason: null }, identity: { version: 'b10519' },
      runtime: { phase: 'idle', request: null, server: { active: 0, queued: 0 }, slots: [], catalog: [{ name: 'example-27b-q4.gguf', format: 'gguf', loaded: true, contextWindowTokens: 32_768 }] } });
    expect(Object.keys(first.capabilities).sort()).toEqual(['request.context', 'request.decodeRate', 'request.tokens', 'server.catalog',
      'server.completions', 'server.rates', 'server.requests', 'server.slots', 'server.speculative']);
    runtime.advance(1_000);
    await read();
    expect(runtime.paths()).toEqual(['/health']);                 // /props every 60 s, /metrics every 5 s
    runtime.advance(4_000);
    await read();
    expect(runtime.paths()).toEqual(['/health', '/metrics']);
  });

  test('b10519: /slots at 1 s only while /metrics shows work, stopping at the first idle read', async () => {
    const { runtime, read } = server('b10519', { '/metrics': ok('metrics.scrape-1.txt'), '/slots': ok('slots.one-busy.json') });
    const busy = await read();
    expect(runtime.paths()).toEqual(['/health', '/props', '/metrics', '/slots']);
    expect(busy.runtime).toMatchObject({ phase: 'decode', server: { active: 1, queued: 0 },
      request: { model: 'example-27b-q4.gguf', promptTokens: 8_354, cachedTokens: 6_144, outputTokens: 225, contextWindowTokens: 32_768, contextUsedTokens: 8_579 } });
    expect(busy.runtime.slots).toEqual([{ id: 0, busy: true, contextWindowTokens: 32_768, decodedTokens: 225, promptTokens: 8_354 },
      { id: 1, busy: false, contextWindowTokens: 32_768 }, { id: 2, busy: false, contextWindowTokens: 32_768 }, { id: 3, busy: false, contextWindowTokens: 32_768 }]);
    runtime.advance(1_000);
    runtime.routes['/slots'] = slotsText('b10519', 'slots.one-busy.json', slots => { slots[0]!.next_token[0].n_decoded = 270; slots[0]!.n_prompt_tokens = 8_624; });
    const decoding = await read();
    expect(runtime.paths()).toEqual(['/health', '/slots']);
    expect(decoding.runtime.request).toMatchObject({ outputTokens: 270, decodeTps: 45 });
    runtime.advance(1_000);
    runtime.routes['/slots'] = ok('slots.all-idle.json');
    const done = await read();
    expect(runtime.paths()).toEqual(['/health', '/slots']);
    expect(done.runtime).toMatchObject({ phase: 'idle', request: null, server: { active: 0, queued: 0 } });
    // b10519 zeroes the released slot: the completion keeps the last busy read's count.
    expect(done.completions).toEqual([{ finishedAt: EPOCH + 2_000, startedAt: null, model: 'example-27b-q4.gguf', basis: 'observed',
      outputTokens: 270, promptTokens: 8_354, cachedTokens: 6_144, decodeTps: 45, overlapped: false }]);
    // The first idle read stops /slots, even though the last /metrics (3 s old) still shows work.
    for (let step = 0; step < 2; step += 1) { runtime.advance(1_000); await read(); expect(runtime.paths()).toEqual(['/health']); }
    runtime.advance(1_000);
    await read();
    expect(runtime.paths()).toEqual(['/health', '/metrics', '/slots']);   // a fresh scrape still shows work
  });

  test('b10519 asleep: nothing but /health, bare /props and the cached /metrics; a scrape showing work means it woke', async () => {
    const { runtime, read } = server('b10519', { '/props': ok('props.sleeping.json') });
    const asleep = await read();
    expect(runtime.paths()).toEqual(['/health', '/props', '/metrics']);
    expect(asleep).toMatchObject({ status: { state: 'ready', reason: 'sleeping' },
      runtime: { phase: 'idle', request: null, server: { active: 0, queued: 0 }, slots: [], catalog: [{ loaded: false }] } });
    for (let step = 0; step < 12; step += 1) { runtime.advance(1_000); await read(); }
    expect(runtime.log.filter(path => path === '/slots')).toEqual([]);
    runtime.routes['/metrics'] = ok('metrics.scrape-1.txt');
    runtime.routes['/slots'] = ok('slots.one-busy.json');
    runtime.advance(5_000); runtime.paths();
    const awake = await read();
    expect(runtime.paths()).toEqual(['/health', '/metrics', '/slots']);
    expect(awake).toMatchObject({ status: { state: 'ready', reason: null }, runtime: { phase: 'decode', catalog: [{ loaded: true }] } });
  });

  test('b10519: /props asleep with a scrape taken in the same read is not proof of waking; the next scrape is', async () => {
    const { runtime, read } = server('b10519', { '/props': ok('props.sleeping.json'), '/metrics': ok('metrics.scrape-1.txt'), '/slots': ok('slots.one-busy.json') });
    expect((await read()).status.reason).toBe('sleeping');
    expect(runtime.paths()).toEqual(['/health', '/props', '/metrics']);
    runtime.advance(LLAMA_METRICS_EVERY_MS);
    expect((await read()).status.reason).toBeNull();
    expect(runtime.paths()).toEqual(['/health', '/metrics', '/slots']);
  });

  test('b10519: an old scrape showing work never starts /slots (the server may have fallen asleep since)', async () => {
    const { runtime, read } = server('b10519', { '/metrics': ok('metrics.scrape-1.txt'), '/slots': ok('slots.one-busy.json') });
    await read();
    expect(runtime.paths()).toContain('/slots');
    runtime.routes['/metrics'] = { status: 500, text: 'busy' };
    runtime.advance(30_000);                                        // no view for 30 s, then /metrics fails
    await read();
    expect(runtime.paths()).toEqual(['/health', '/metrics']);
  });

  test('b10519 without --metrics: no live slots, "metrics_required"; a build whose /metrics wakes it says so', async () => {
    const plain = server('b10519', { '/props': ok('props.no-metrics.json') });
    for (let step = 0; step < 8; step += 1) { await plain.read(); plain.runtime.advance(1_000); }
    expect(new Set(plain.runtime.log)).toEqual(new Set(['/health', '/props']));
    const reading = await plain.read();
    expect(reading).toMatchObject({ status: { state: 'degraded', reason: 'metrics_required', params: { wakes: false } },
      runtime: { phase: 'unknown', server: { active: null, queued: null }, slots: [] } });
    expect(Object.keys(reading.capabilities)).toEqual(['server.catalog']);
    const waking = server('b10519', { '/props': withProps('b10519', 'props.normal.json', body => { body.build_info = 'b9000-abcdef0'; }) });
    for (let step = 0; step < 8; step += 1) { await waking.read(); waking.runtime.advance(1_000); }
    expect(new Set(waking.runtime.log)).toEqual(new Set(['/health', '/props']));
    expect((await waking.read()).status).toEqual({ state: 'degraded', reason: 'metrics_required', params: { wakes: true } });
  });

  test('b6700 cannot sleep: /slots every read, with or without /metrics', async () => {
    for (const props of ['props.normal.json', 'props.no-metrics.json']) {
      const { runtime, read } = server('b6700', { '/props': ok(props), '/metrics': ok('metrics.scrape-1.txt'), '/slots': ok('slots.all-idle.json') });
      await read();
      runtime.advance(1_000);
      const reading = await read();
      expect(runtime.log.filter(path => path === '/slots'), props).toHaveLength(2);
      expect(runtime.log.includes('/metrics'), props).toBe(props === 'props.normal.json');
      expect(reading.status, props).toEqual({ state: 'ready', reason: null, params: {} });
      // Idle slots carry no counts on the wire: b6700 keeps the previous request's there.
      expect(reading.runtime.slots, props).toEqual([0, 1, 2, 3].map(id => ({ id, busy: false, contextWindowTokens: 8_192 })));
      expect(reading.runtime.server, props).toEqual(props === 'props.normal.json' ? { active: 0, queued: 0 } : { active: 0, queued: null });
    }
  });

  test('b6700: an observed start, rate and exact final count (the released slot keeps n_decoded)', async () => {
    const { runtime, read } = server('b6700', { '/metrics': ok('metrics.scrape-1.txt'), '/slots': ok('slots.all-idle.json') });
    await read();
    runtime.advance(1_000);
    runtime.routes['/slots'] = ok('slots.one-busy.json');
    const started = await read();
    expect(started.runtime).toMatchObject({ phase: 'decode', request: { outputTokens: 220, contextWindowTokens: 8_192 } });
    expect(started.runtime.request).not.toHaveProperty('promptTokens');   // b6700 /slots has no prompt counts
    expect(started.runtime.slots[0]).toEqual({ id: 0, busy: true, contextWindowTokens: 8_192, decodedTokens: 220, remainingTokens: 1_828 });
    runtime.advance(2_000);
    runtime.routes['/slots'] = slotsText('b6700', 'slots.one-busy.json', slots => { slots[0]!.next_token.n_decoded = 284; slots[0]!.next_token.n_remain = 1_764; });
    expect((await read()).runtime.request?.decodeTps).toBe(32);
    runtime.advance(1_000);
    runtime.routes['/slots'] = ok('slots.all-idle.json');
    const done = await read();
    expect(done.completions).toEqual([{ finishedAt: EPOCH + 4_000, startedAt: EPOCH + 1_000, model: 'example-27b-q4.gguf', basis: 'observed',
      outputTokens: 540, decodeTps: 32, overlapped: false }]);
  });

  test('two busy slots: per-request speed withheld, and the survivor\'s completion is overlapped', async () => {
    const { runtime, read } = server('b10519', { '/metrics': ok('metrics.scrape-2.txt'), '/slots': ok('slots.one-busy.json') });
    await read();
    runtime.advance(1_000);
    runtime.routes['/slots'] = ok('slots.two-busy.json');
    const both = await read();
    expect(both.runtime).toMatchObject({ phase: 'processing', request: null, server: { active: 2, queued: 0 } });
    expect(both.runtime.slots.filter(slot => slot.busy).map(slot => slot.id)).toEqual([0, 2]);
    expect(both.runtime.slots.every(slot => slot.decodeTps === undefined)).toBe(true);
    runtime.advance(1_000);
    runtime.routes['/slots'] = slotsText('b10519', 'slots.two-busy.json', slots => {
      Object.assign(slots[2]!, { is_processing: false, n_prompt_tokens_processed: 0, n_prompt_tokens_cache: 0 });
      slots[2]!.next_token[0].n_decoded = 0;
    });
    const one = await read();
    expect(one.completions).toEqual([]);                           // slot 2 was not the only busy slot
    expect(one.runtime.request?.decodeTps).toBeUndefined();        // no rate right after an overlap: last read had two
    runtime.advance(1_000);
    runtime.routes['/slots'] = ok('slots.all-idle.json');
    const done = await read();
    expect(done.completions).toHaveLength(1);
    expect(done.completions[0]).toMatchObject({ overlapped: true, outputTokens: 450, basis: 'observed' });
  });

  test('router mode: only /health and bare /props, ever', async () => {
    const { runtime, read } = server('b10519', { '/props': ok('props.router.json') });
    for (let step = 0; step < 70; step += 1) {
      const reading = await read();
      expect(reading.status).toEqual({ state: 'unconfigured', reason: 'unsupported_runtime', params: {} });
      runtime.advance(1_000);
    }
    expect(new Set(runtime.log)).toEqual(new Set(['/health', '/props']));
    expect(runtime.log.filter(path => path === '/props')).toHaveLength(2);
  });

  test('bare paths only: no model, autoload or fail_on_no_slot parameters, and bare /props at most every 60 s', async () => {
    const { runtime, read } = server('b10519', { '/metrics': ok('metrics.scrape-1.txt'), '/slots': ok('slots.one-busy.json') });
    for (let step = 0; step < 130; step += 1) { await read(); runtime.advance(500); }
    expect(new Set(runtime.log)).toEqual(new Set(['/health', '/props', '/metrics', '/slots']));
    expect(runtime.log.filter(path => path === '/props')).toHaveLength(Math.ceil(130 * 500 / LLAMA_PROPS_EVERY_MS));
  });

  test('the glance tier follows the same rule', async () => {
    const { runtime, read } = server('b10519', { '/props': ok('props.sleeping.json') });
    for (let step = 0; step < 6; step += 1) { await read('glance'); runtime.advance(1_000); }
    expect(runtime.log.includes('/slots')).toBe(false);
  });
});

describe('failures and degradation', () => {
  test('/health 503 is loading and reads nothing else; the next healthy read re-reads /props', async () => {
    const { runtime, read } = server('b10519');
    await read();
    runtime.paths();
    runtime.routes['/health'] = status(503, 'health.loading-503.json');
    runtime.advance(1_000);
    expect(await read()).toMatchObject({ status: { state: 'degraded', reason: 'loading' }, runtime: { phase: 'loading' } });
    expect(runtime.paths()).toEqual(['/health']);
    runtime.routes['/health'] = ok('health.ok.json');
    runtime.advance(1_000);
    await read();
    expect(runtime.paths()).toEqual(['/health', '/props']);
    const b6700 = server('b6700', { '/health': status(503, 'health.loading-503.json') });
    expect((await b6700.read()).status.reason).toBe('loading');
  });

  test('401 on /props is authentication_failed; a network failure is thrown for the slot', async () => {
    for (const build of ['b10519', 'b6700'] as const) {
      const { read } = server(build, { '/props': status(401, 'props.unauthorized-401.json') });
      const error = await read().catch(caught => caught);
      expect(error).toBeInstanceOf(HttpFailure);
      expect([error.reason, error.status]).toEqual(['authentication_failed', 401]);
    }
    const down = server('b10519', { '/health': 'network' });
    expect(await down.read().catch(caught => caught)).toBeInstanceOf(HttpFailure);
  });

  test('--no-slots and a disabled /metrics degrade their capability, not the runtime', async () => {
    for (const build of ['b10519', 'b6700'] as const) {
      const noSlots = server(build, { '/metrics': ok('metrics.scrape-1.txt'), '/slots': status(501, 'slots.disabled-501.json') });
      await noSlots.read();
      noSlots.runtime.advance(1_000);
      const reading = await noSlots.read();
      expect(noSlots.runtime.log.filter(path => path === '/slots'), build).toHaveLength(1);
      expect(reading.status.state, build).toBe('ready');
      expect(reading.capabilities, build).not.toHaveProperty('server.slots');
      expect(reading.runtime, build).toMatchObject({ phase: 'processing', server: { active: 1 } });
      const noMetrics = server(build, { '/metrics': status(501, 'metrics.disabled-501.json') });
      await noMetrics.read();
      noMetrics.runtime.advance(6_000);
      const plain = await noMetrics.read();
      expect(noMetrics.runtime.log.filter(path => path === '/metrics'), build).toHaveLength(1);
      expect(plain.capabilities, build).not.toHaveProperty('server.rates');
      // b10519 can sleep: without /metrics it shows no live slots. b6700 cannot: /slots carries on.
      expect(plain.status.reason, build).toBe(build === 'b10519' ? 'metrics_required' : null);
      expect(noMetrics.runtime.log.includes('/slots'), build).toBe(build === 'b6700');
    }
  });

  test('another runtime where /props was: unsupported_contract, so three in a row re-detect', async () => {
    const { runtime, read, adapter } = server('b10519', { '/props': { status: 200, text: '{"ready":true}' } });
    expect((await read()).status).toEqual({ state: 'degraded', reason: 'unsupported_contract', params: {} });
    expect(await adapter.identity()).toBe(false);
    runtime.routes['/props'] = ok('props.normal.json');
    runtime.advance(LLAMA_PROPS_EVERY_MS);
    expect(await adapter.identity()).toBe(true);
    expect((await read()).status.state).toBe('ready');
  });
});

describe('rates and speculative decoding (Δ*_total / Δ*_seconds_total)', () => {
  test('b10519 scrapes 5 s apart: no decode rate while nothing completed, then 45 tok/s; prompt 800 tok/s; acceptance 0.416667', () => {
    const [one, two, three] = [1, 2, 3].map(step => metrics('b10519', `metrics.scrape-${step}.txt`));
    expect(llamaRates(one!, two!, 5_000)).toEqual({ promptTps: 800, windowMs: 5_000 });
    expect(llamaRates(two!, three!, 5_000)).toEqual({ decodeTps: 45, windowMs: 5_000 });   // not 540/5 = 108
    expect(llamaSpeculative(two!, three!, 5_000)).toEqual({ draftedTokens: 720, acceptedTokens: 300, acceptanceFraction: 0.416667, windowMs: 5_000 });
    expect(llamaSpeculative(one!, two!, 5_000)).toBeUndefined();
    expect(llamaRates(one!, three!, 10_000)).toEqual({ promptTps: 800, decodeTps: 45, windowMs: 10_000 });
    expect(llamaRates(one!, two!)).toBeUndefined();                // no window, no rate
    const noSpec = metrics('b10519', 'metrics.no-spec.txt');
    expect(llamaSpeculative(noSpec, noSpec, 5_000)).toBeUndefined();
  });

  test('b6700: 666.667 then 32 tok/s; no speculative series', () => {
    const [one, two, three] = [1, 2, 3].map(step => metrics('b6700', `metrics.scrape-${step}.txt`));
    expect(llamaRates(one!, two!, 5_000)).toEqual({ promptTps: 666.667, windowMs: 5_000 });
    expect(llamaRates(two!, three!, 5_000)).toEqual({ decodeTps: 32, windowMs: 5_000 });
    expect(llamaSpeculative(two!, three!, 5_000)).toBeUndefined();
  });

  test('a counter going backwards is a restart; steps inside the 6-digit print quantum are withheld', () => {
    const idle = metrics('b10519', 'metrics.idle.txt'), large = metrics('b10519', 'metrics.large-counters.txt');
    expect([llamaRestarted(large, idle), llamaRestarted(idle, large)]).toEqual([true, false]);
    expect(llamaRates(large, idle, 5_000)).toBeUndefined();
    const nudge = (text: string) => parsePrometheus(text, { allow: name => LLAMA_METRICS.has(name) });
    const base = file('b10519', 'metrics.large-counters.txt');
    // 1.04873e+06 → 1.04874e+06 is ±10 tokens of print noise over 0.1 s: not a rate.
    const noisy = nudge(base.replace('tokens_predicted_total 1.04873e+06', 'tokens_predicted_total 1.04874e+06').replace('seconds_total 26511.4', 'seconds_total 26511.5'));
    expect(llamaRates(large, noisy, 5_000)).toBeUndefined();
    const real = nudge(base.replace('tokens_predicted_total 1.04873e+06', 'tokens_predicted_total 1.05143e+06').replace('seconds_total 26511.4', 'seconds_total 26571.4'));
    expect(llamaRates(large, real, 60_000)).toEqual({ decodeTps: 45, windowMs: 60_000 });
  });

  test('the adapter windows: rates over ≤ 60 s, speculative over ≤ 10 min, restarted on a counter reset', async () => {
    const { runtime, read } = server('b10519', { '/metrics': ok('metrics.scrape-1.txt'), '/slots': ok('slots.one-busy.json') });
    expect((await read()).runtime.server.rates).toBeUndefined();
    runtime.advance(5_000); runtime.routes['/metrics'] = ok('metrics.scrape-2.txt');
    expect((await read()).runtime.server.rates).toEqual({ promptTps: 800, windowMs: 5_000 });
    runtime.advance(5_000); runtime.routes['/metrics'] = ok('metrics.scrape-3.txt');
    const third = await read();
    expect(third.runtime.server).toMatchObject({ rates: { promptTps: 800, decodeTps: 45, windowMs: 10_000 },
      speculative: { draftedTokens: 720, acceptedTokens: 300, windowMs: 10_000 } });
    runtime.advance(5_000); runtime.routes['/metrics'] = ok('metrics.large-counters.txt');
    expect((await read()).runtime.server.rates).toMatchObject({ windowMs: 15_000 });
    runtime.advance(5_000); runtime.routes['/metrics'] = ok('metrics.idle.txt');
    const restarted = await read();
    expect(restarted.runtime.server.rates).toBeUndefined();         // a counter going back: the ring starts over
    expect(restarted.runtime.server.speculative).toBeUndefined();
  });
});

describe('/slots allowlist and completions', () => {
  test('parseSlots keeps numbers only, and never a prompt, generated text, params or generation_prompt', () => {
    for (const build of ['b10519', 'b6700'] as const) {
      for (const name of readdirSync(join(ROOT, build)).filter(entry => /^slots\..*\.json$/.test(entry) && !entry.includes('501'))) {
        const slots = parseSlots(json(build, name));
        expect(slots.length, name).toBe(4);
        expect(JSON.stringify(slots), name).not.toMatch(CANARIES);
        expect(JSON.stringify(readSlots(json(build, name))), name).not.toMatch(/CANARY|prompt"|generated|params|temperature/);
        for (const slot of slots) expect(Object.keys(slot).every(key => ['id', 'busy', 'contextWindowTokens', 'decodedTokens', 'remainingTokens', 'promptTokens'].includes(key))).toBe(true);
      }
    }
    expect(parseSlots(json('b10519', 'slots.debug.json'))[0]).toEqual({ id: 0, busy: true, contextWindowTokens: 32_768, decodedTokens: 225, promptTokens: 8_354 });
    expect(parseSlots(json('b10519', 'slots.fresh.json'))).toEqual([0, 1, 2, 3].map(id => ({ id, busy: false, contextWindowTokens: 32_768 })));
    for (const body of [null, {}, json('b10519', 'slots.disabled-501.json'), [{ id: -1 }], [{ id: 0, is_processing: 'yes', n_ctx: 1 }]]) expect(parseSlots(body)).toEqual([]);
  });

  test('slotCompletion: only the sole busy slot going idle, with its last busy count', () => {
    const oneBusy = parseSlots(json('b10519', 'slots.one-busy.json')), idle = parseSlots(json('b10519', 'slots.all-idle.json'));
    expect(slotCompletion(oneBusy, idle, EPOCH)).toEqual({ finishedAt: EPOCH, startedAt: null, model: null, basis: 'observed',
      outputTokens: 225, promptTokens: 8_354, overlapped: false });
    expect(slotCompletion(parseSlots(json('b10519', 'slots.two-busy.json')), idle, EPOCH)).toBeNull();
    expect(slotCompletion(oneBusy, oneBusy, EPOCH)).toBeNull();
    expect(slotCompletion(idle, idle, EPOCH)).toBeNull();
    expect(slotCompletion(oneBusy, parseSlots(json('b10519', 'slots.two-busy.json')).map(slot => slot.id === 0 ? { ...slot, busy: false } : slot), EPOCH))
      .toMatchObject({ overlapped: true });
  });

  test('SlotWatch: a read gap breaks the span (no completion, no rate across it)', () => {
    const watch = new SlotWatch(), busy = readSlots(json('b6700', 'slots.one-busy.json')), idle = readSlots(json('b6700', 'slots.all-idle.json'));
    watch.observe(idle, EPOCH, 0, 'm');
    watch.observe(busy, EPOCH + 1_000, 1_000, 'm');
    expect(watch.following(2_000)).toBe(true);
    expect(watch.following(6_001)).toBe(false);
    expect(watch.observe(idle, EPOCH + 9_000, 9_000, 'm')).toEqual({ completion: null, decodeTps: null });
  });

  test('SlotWatch: a request finishing while another is busy is not recorded (only the sole busy slot is)', () => {
    const watch = new SlotWatch(), one = readSlots(json('b10519', 'slots.one-busy.json')), two = readSlots(json('b10519', 'slots.two-busy.json'));
    const otherOnly = two.map(slot => slot.id === 0 ? { ...slot, busy: false, decoded: 0 } : slot);
    watch.observe(one, EPOCH, 0, 'm');
    watch.observe(two, EPOCH + 1_000, 1_000, 'm');
    expect(watch.observe(otherOnly, EPOCH + 2_000, 2_000, 'm')).toEqual({ completion: null, decodeTps: null });
    // The survivor then ends as the sole busy slot: recorded, overlapped, its start and (never past prefill) its count unknown.
    expect(watch.observe(readSlots(json('b10519', 'slots.all-idle.json')), EPOCH + 3_000, 3_000, 'm').completion).toEqual({
      finishedAt: EPOCH + 3_000, startedAt: null, model: 'm', basis: 'observed', promptTokens: 1_152, cachedTokens: 512, overlapped: true });
  });

  test('SlotWatch: a new task on the same slot completes the previous one and starts an observed span', () => {
    const watch = new SlotWatch(), first = readSlots(json('b6700', 'slots.one-busy.json'));
    const next = first.map(slot => slot.id === 0 ? { ...slot, task: 9_999, decoded: 3 } : slot);
    watch.observe(first, EPOCH, 0, 'm');
    const handover = watch.observe(next, EPOCH + 1_000, 1_000, 'm');
    expect(handover.completion).toMatchObject({ outputTokens: 220, overlapped: false, startedAt: null });
    const finish = watch.observe(readSlots(json('b6700', 'slots.all-idle.json')).map(slot => slot.id === 0 ? { ...slot, task: 9_999, decoded: 30 } : slot), EPOCH + 2_000, 2_000, 'm');
    expect(finish.completion).toMatchObject({ startedAt: EPOCH + 1_000, outputTokens: 30 });
  });
});

describe('round trip over every llama-server fixture', () => {
  const scenarios: Record<Build, Array<Record<string, Route>>> = {
    b10519: [
      {}, { '/metrics': ok('metrics.scrape-1.txt'), '/slots': ok('slots.one-busy.json') },
      { '/metrics': ok('metrics.scrape-2.txt'), '/slots': ok('slots.two-busy.json') }, { '/metrics': ok('metrics.scrape-3.txt'), '/slots': ok('slots.debug.json') },
      { '/metrics': ok('metrics.large-counters.txt'), '/slots': ok('slots.fresh.json') }, { '/metrics': ok('metrics.no-spec.txt'), '/slots': ok('slots.all-idle.json') },
      { '/props': ok('props.sleeping.json') }, { '/props': ok('props.no-metrics.json') }, { '/props': ok('props.router.json') },
      { '/metrics': status(501, 'metrics.disabled-501.json') }, { '/metrics': ok('metrics.scrape-1.txt'), '/slots': status(501, 'slots.disabled-501.json') },
      { '/health': status(503, 'health.loading-503.json') }, { '/props': status(401, 'props.unauthorized-401.json') },
    ],
    b6700: [
      {}, { '/metrics': ok('metrics.scrape-1.txt'), '/slots': ok('slots.one-busy.json') }, { '/metrics': ok('metrics.scrape-2.txt'), '/slots': ok('slots.two-busy.json') },
      { '/metrics': ok('metrics.scrape-3.txt'), '/slots': ok('slots.all-idle.json') }, { '/props': ok('props.no-metrics.json') },
      { '/metrics': status(501, 'metrics.disabled-501.json'), '/slots': status(501, 'slots.disabled-501.json') },
      { '/health': status(503, 'health.loading-503.json') }, { '/props': status(401, 'props.unauthorized-401.json') },
    ],
  };
  for (const build of ['b10519', 'b6700'] as const) {
    test(`${build}: every reading parses unchanged, nothing class A, no canary, and every fixture is served`, async () => {
      const served = new Set<string>();
      const sequence = scenarios[build];
      // Each scenario also runs after every other one, so each route meets each state the adapter can be in.
      for (const [index, routes] of sequence.entries()) {
        const { runtime, adapter, read } = server(build, routes);
        const steps: AdapterV2[] = [adapter];
        for (const next of [...sequence.slice(index + 1), ...sequence.slice(0, index + 1)]) {
          for (let step = 0; step < 3; step += 1) {
            const reading = await read().catch(error => { if (error instanceof HttpFailure) return null; throw error; });
            if (reading) expect(texts(reading), `${build} scenario ${index}`).not.toMatch(CANARIES);
            runtime.advance(step === 2 ? 20_000 : 1_000);
          }
          Object.assign(runtime.routes, { '/health': ok('health.ok.json'), '/props': ok('props.normal.json'), '/metrics': ok('metrics.idle.txt'),
            '/slots': ok('slots.all-idle.json') }, next);
        }
        steps.forEach(item => item.dispose());
        runtime.served.forEach(name => served.add(name));
      }
      const all = readdirSync(join(ROOT, build)).filter(name => name !== 'SOURCE.md');
      expect([...served].sort()).toEqual(all.sort());
    });
  }

  test('label values and unallowlisted series never reach a reading', async () => {
    const leaky = `${file('b10519', 'metrics.scrape-1.txt')}llamacpp:requests_processing{model="CANARY-LABEL-7f3a"} 9\nllamacpp:secret_total{path="/Users/fixture/CANARY-PATH-7f3a"} 1\n`;
    const { read } = server('b10519', { '/metrics': { status: 200, text: leaky }, '/slots': ok('slots.debug.json') });
    const reading = await read();
    expect(reading.runtime.server.active).toBe(1);                 // the first, unlabelled sample
    expect(texts(reading)).not.toMatch(CANARIES);
  });
});
