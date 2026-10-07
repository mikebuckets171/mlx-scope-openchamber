import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bodyChars, classAKeys, MAX_BODY_CHARS } from '../../src/contract/guards.ts';
import { honestyViolations, parseSnapshotV2 } from '../../src/contract/snapshot.ts';
import { unitViolations } from '../../src/contract/units.ts';
import type { AdapterContextV2, AdapterReadingV2, CompletionDraft, RuntimeReply } from '../core/adapter-v2.ts';
import { HttpFailure } from '../http.ts';
import {
  isSplash11, SPLASH_GAP_MS, SPLASH_RATE_GAP_MS, SPLASH_RECOVERING_CACHE_MS, SplashCompletions, SplashRates,
  splashCompletion, splashDescriptor, splashReading, splashStatus,
} from './splash.ts';

type Json = Record<string, any>;
const ROOT = join(import.meta.dir, '../../tests/fixtures/splash');
const AT = 1_790_690_700_000, INSTANCE = '5c1e0a7b', MODEL = 'publisher/Example-27B-4bit';
const load = (version: string, file: string): Json => JSON.parse(readFileSync(join(ROOT, version, file), 'utf8'));
const status = (variant: string, version = '1.1.0') => load(version, `status.${variant}.json`);
const clone = <T>(value: T): T => structuredClone(value);
const FIXTURES = ['1.2.0', '1.1.0', '1.0.2'].flatMap(version => readdirSync(join(ROOT, version))
  .filter(file => file.startsWith('status.')).sort().map(file => ({ version, variant: file.slice(7, -5), body: load(version, file) })));
const EXPECTED: Record<string, [string, string | null]> = {
  'ready-idle': ['ready', null], decoding: ['ready', null], vision: ['ready', null], 'ready-after-crash': ['ready', null],
  'delta1-before': ['ready', null], 'delta1-after': ['ready', null], 'delta2-before': ['ready', null], 'delta2-after': ['ready', null],
  recovering: ['recovering', 'recovering'], 'status-stale': ['degraded', 'status_stale'], 'stale-no-snapshot': ['degraded', 'status_stale'],
  'metal-unhealthy': ['degraded', 'not_admitting'], 'memory-critical': ['degraded', 'not_admitting'],
};

// Class A from the corpus (tests/fixtures/splash/*/SOURCE.md): none of it may reach a reading, a draft or a body.
const CANARY_TEXT = ['CANARY', '198.51.100.42', '/Users/', '.trace', 'native engine', 'native status', 'Metal command buffer',
  '4242', '18742', '1790636042'];
const CANARY_NUMBERS = [4242, 18742, 1_790_636_042.4242, 1_790_636_042_424.2];
const leaves = (value: unknown, out: Array<string | number> = []): Array<string | number> => {
  if (typeof value === 'string' || typeof value === 'number') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => leaves(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => leaves(item, out));
  return out;
};
const expectClean = (name: string, value: unknown) => {
  // `identity` is also AdapterReadingV2's own field (version/engine/host); Splash has none to fill.
  const { identity, ...rest } = value as Json;
  expect(identity === undefined || JSON.stringify(identity) === '{}', name).toBe(true);
  expect(classAKeys(rest), name).toEqual([]);
  for (const leaf of leaves(value)) {
    if (typeof leaf === 'number') expect(CANARY_NUMBERS.includes(leaf), `${name}: ${leaf}`).toBe(false);
    // An 8-hex string is an opaque key or the service instance, and may spell digits by chance.
    else if (!/^[0-9a-f]{8}$/.test(leaf)) for (const needle of CANARY_TEXT) expect(leaf, name).not.toContain(needle);
  }
};

/** The fields svc-2b's composer adds, around one adapter reading: enough for parseSnapshotV2 to judge the reading. */
const snapshotOf = (reading: Omit<AdapterReadingV2, 'completions'>, drafts: CompletionDraft[] = []) => JSON.parse(JSON.stringify({
  contractVersion: 2, serverNow: reading.at + 40, service: { version: '2.0.0', instance: INSTANCE },
  connection: { id: 'splash', label: 'Splash', runtime: 'splash', ...reading.identity, generation: 1,
    choices: [{ id: 'splash', label: 'Splash', runtime: 'splash' }], detection: { basis: 'probe', confidence: 'high', probe: '/status' } },
  status: reading.status, capabilities: reading.capabilities, runtime: reading.runtime, host: null,
  completions: { instance: INSTANCE, cursor: drafts.length, reset: false, items: drafts.map((draft, index) => ({ ...draft, seq: index + 1, host: {} })) },
  marksHead: 0, alerts: [], alertLog: [], lease: { leader: true, epoch: 1, ttlMs: 12_000, leaderSurface: 'panel' }, nextPollMs: 2_000,
}));
const expectRoundTrip = (name: string, body: Json) => {
  expect(parseSnapshotV2(body), name).toEqual(body as never);
  expect([honestyViolations(body), unitViolations(body)], name).toEqual([[], []]);
  expect(bodyChars(body)).toBeLessThan(MAX_BODY_CHARS);
  expectClean(name, body);
};

/** A later /status body: `requests` steps, plus a TTFT observation per `ttftMs` entry (seconds on the wire). */
const after = (base: Json, step: { submitted?: number; completed?: number; failed?: number; cancelled?: number; ttftMs?: number[];
  active?: number; queued?: number; tokens?: [prefill: number, prefillMs: number, decode: number, decodeMs: number] }): Json => {
  const body = clone(base), r = body.requests, ttft = body.latency.ttft;
  r.submitted += step.submitted ?? 0; r.completed += step.completed ?? 0; r.failed += step.failed ?? 0; r.cancelled += step.cancelled ?? 0;
  for (const ms of step.ttftMs ?? []) { ttft.count += 1; ttft.sum += ms / 1000; }
  if (step.active !== undefined) { body.scheduler.decoding = step.active; body.http.requests.active = step.active; }
  if (step.queued !== undefined) body.scheduler.queued = step.queued;
  if (step.tokens) {
    const m = body.metrics, [prefill, prefillMs, decode, decodeMs] = step.tokens;
    m.prefill_input_tokens += prefill; m.prefill_wall_ms += prefillMs; m.decode_output_tokens += decode; m.decode_wall_ms += decodeMs;
  }
  return body;
};
const IDLE = status('ready-idle');
/** One request in flight on top of the idle body, before (`true`) or after its first token. */
const busy = (firstToken: boolean) => after(IDLE, { submitted: 1, active: 1, ttftMs: firstToken ? [300] : [] });

describe('live native decode rates', () => {
  const running = busy(true), next = after(running, { tokens: [0, 0, 60, 500] });

  test('three fresh samples span two seconds and use total command time, not mean batch or retained speed', () => {
    const rates = new SplashRates(), advanced = clone(next);
    advanced.metrics.current_decode_batch = { valid: true, tokens_per_second: 987 };
    advanced.metrics.decode_tokens_per_second = 456;
    expect(rates.observe(running, 0)).toBeUndefined();
    expect(rates.observe(advanced, 1_000)).toBeUndefined();
    const later = after(advanced, { tokens: [0, 0, 11, 300] });
    expect(rates.observe(later, 2_000)).toEqual({ decodeTps: 88.75, windowMs: 2_000 });
    // Repeated status values are not another live sample, even if a retained batch remains valid.
    expect(rates.observe(later, 3_000)).toBeUndefined();
    expect(rates.observe(after(later, { tokens: [0, 0, 49, 200] }), 4_000)).toEqual({ decodeTps: 120, windowMs: 4_000 });
  });

  test('mixed prefill/decode and waiting-mask work use real native decode activity', () => {
    for (const scheduler of [{ prefilling: 1, decoding: 1 }, { prefilling: 0, decoding: 0, waiting_mask: 1 }]) {
      const rates = new SplashRates(), a = clone(running), b = clone(next);
      Object.assign(a.scheduler, scheduler); Object.assign(b.scheduler, scheduler);
      expect(rates.observe(a, 0)).toBeUndefined();
      expect(rates.observe(b, 1_000)).toBeUndefined();
      expect(rates.observe(after(b, { tokens: [0, 0, 60, 500] }), 2_000)).toEqual({ decodeTps: 120, windowMs: 2_000 });
    }
  });

  const invalidBodies: Array<[string, (body: Json) => void]> = [
    ['stale', body => { body.transport.status_stale = true; }],
    ['recovering', body => { body.transport.recovering = true; }],
    ['not ready', body => { body.ready = false; }],
    ['transport closing', body => { body.transport.ready = false; }],
    ['transport stopped', body => { body.transport.stopped = true; }],
    ['idle or HTTP streaming only', body => { body.scheduler.decoding = 0; body.scheduler.waiting_mask = 0; }],
    ['prefill only', body => { body.scheduler.decoding = 0; body.scheduler.waiting_mask = 0; body.scheduler.prefilling = 1; }],
    ['unknown scheduler', body => { delete body.scheduler; }],
    ['missing token counter', body => { delete body.metrics.decode_output_tokens; }],
    ['missing time counter', body => { delete body.metrics.decode_wall_ms; }],
    ['negative token counter', body => { body.metrics.decode_output_tokens = -1; }],
    ['fractional token counter', body => { body.metrics.decode_output_tokens = 1.5; }],
    ['unsafe token counter', body => { body.metrics.decode_output_tokens = Number.MAX_SAFE_INTEGER + 1; }],
    ['nonfinite time counter', body => { body.metrics.decode_wall_ms = Infinity; }],
    ['negative time counter', body => { body.metrics.decode_wall_ms = -1; }],
  ];
  test.each(invalidBodies)('%s clears the live baseline', (_, mutate) => {
    const rates = new SplashRates(), invalid = clone(next); mutate(invalid);
    rates.observe(running, 0);
    expect(rates.observe(invalid, 1_000)).toBeUndefined();
    expect(rates.observe(next, 2_000)).toBeUndefined();
    const later = after(next, { tokens: [0, 0, 60, 500] });
    expect(rates.observe(later, 3_000)).toBeUndefined();
    expect(rates.observe(after(later, { tokens: [0, 0, 60, 500] }), 4_000)).toEqual({ decodeTps: 120, windowMs: 2_000 });
  });

  test('foreign bodies and explicit reset clear the live baseline', () => {
    const later = after(next, { tokens: [0, 0, 60, 500] }), resumed = after(later, { tokens: [0, 0, 60, 500] });
    for (const body of [null, {}, { ready: 'true' }]) {
      const rates = new SplashRates(); rates.observe(running, 0); rates.observe(next, 1_000);
      expect(rates.observe(later, 2_000)).toEqual({ decodeTps: 120, windowMs: 2_000 });
      expect(rates.observe(body, 3_000)).toBeUndefined();
      expect(rates.observe(resumed, 4_000)).toBeUndefined();
    }
    const rates = new SplashRates(); rates.observe(running, 0); rates.observe(next, 1_000); rates.observe(later, 2_000); rates.reset();
    expect(rates.observe(resumed, 3_000)).toBeUndefined();
  });

  test('process, model, engine restart and counter reset start a new baseline', () => {
    for (const mutate of [
      (body: Json) => { body.instance.id = 'replacement'; },
      (body: Json) => { body.instance.started_at += 1; },
      (body: Json) => { body.instance.model = 'publisher/Another'; },
      (body: Json) => { body.transport.restarts += 1; },
      (body: Json) => { body.metrics.decode_output_tokens = 1; },
      (body: Json) => { body.metrics.decode_wall_ms = 1; },
    ]) {
      const rates = new SplashRates(), changed = clone(next); mutate(changed);
      rates.observe(running, 0);
      expect(rates.observe(changed, 1_000)).toBeUndefined();
      const later = after(changed, { tokens: [0, 0, 60, 500] });
      expect(rates.observe(later, 2_000)).toBeUndefined();
      expect(rates.observe(after(later, { tokens: [0, 0, 60, 500] }), 3_000)).toEqual({ decodeTps: 120, windowMs: 2_000 });
    }
  });

  test('clock faults clear the baseline and long gaps require another fresh observation', () => {
    for (const clock of [NaN, Infinity, -1, 0, 999, 1_000]) {
      const rates = new SplashRates(); rates.observe(running, 1_000);
      expect(rates.observe(next, clock)).toBeUndefined();
      expect(rates.observe(next, 2_000)).toBeUndefined();
    }
    const rates = new SplashRates(); rates.observe(running, 0);
    expect(rates.observe(next, SPLASH_RATE_GAP_MS + 1)).toBeUndefined();
    const later = after(next, { tokens: [0, 0, 60, 500] });
    expect(rates.observe(later, SPLASH_RATE_GAP_MS + 1_001)).toBeUndefined();
    expect(rates.observe(after(later, { tokens: [0, 0, 60, 500] }), SPLASH_RATE_GAP_MS + 2_001))
      .toEqual({ decodeTps: 120, windowMs: 2_000 });
  });

  test('both counters must advance and a nonfinite ratio is never emitted', () => {
    for (const tokens of [[0, 0, 0, 500], [0, 0, 60, 0]] as Array<[number, number, number, number]>) {
      const rates = new SplashRates(); rates.observe(running, 0); rates.observe(next, 1_000);
      expect(rates.observe(after(next, { tokens }), 2_000)).toBeUndefined();
    }
    const tiny = clone(running), overflow = clone(next), rates = new SplashRates();
    tiny.metrics.decode_wall_ms = 0; overflow.metrics.decode_wall_ms = Number.MIN_VALUE;
    rates.observe(tiny, 0);
    expect(rates.observe(tiny, 1_000)).toBeUndefined();
    expect(rates.observe(overflow, 2_000)).toBeUndefined();
  });
});

describe('state precedence (SPIKES S7: recovering > status_stale > not admitting > ready)', () => {
  test.each(FIXTURES.map(item => [`${item.version} ${item.variant}`, item] as const))('%s', (_, { variant, body }) => {
    const result = splashStatus(body, AT);
    expect([result.state, result.reason] as unknown[]).toEqual(EXPECTED[variant]!);
    expect(result.reason).not.toBe('loading');
  });

  test('params carry presence booleans and times, never Splash text', () => {
    expect(splashStatus(status('recovering'), AT)).toEqual({ state: 'recovering', reason: 'recovering',
      params: { retryInMs: SPLASH_RECOVERING_CACHE_MS, crashTrace: true, transportError: true }, sinceAt: Math.round(AT - 1_834.208333) });
    expect(splashStatus(status('status-stale'), AT)).toEqual({ state: 'degraded', reason: 'status_stale',
      params: { staleSinceAt: Math.round(AT - 612.874041), transportError: true } });
    // status_age_ms 0: no snapshot was ever cached, so there is no time to report.
    expect(splashStatus(status('stale-no-snapshot'), AT).params).toEqual({ transportError: true });
    expect(splashStatus(status('metal-unhealthy')).params).toEqual({ metalUnhealthy: true, memoryCritical: false, metalFailure: true });
    expect(splashStatus(status('memory-critical')).params).toEqual({ metalUnhealthy: false, memoryCritical: true, metalFailure: false });
    const quiet = clone(status('recovering'));
    quiet.transport.last_crash_trace = null; delete quiet.transport.error; quiet.transport.status_age_ms = 0;
    expect(splashStatus(quiet, AT)).toEqual({ state: 'recovering', reason: 'recovering',
      params: { retryInMs: SPLASH_RECOVERING_CACHE_MS, crashTrace: false, transportError: false } });
  });

  test('each rule outranks the ones below it', () => {
    const all = clone(IDLE);
    Object.assign(all.transport, { recovering: true, ready: false, status_stale: true, error: 'x' });
    Object.assign(all, { memory_pressure: 'critical', metal: { healthy: false, failure_reason: '' } });
    expect(splashStatus(all).reason).toBe('recovering');
    all.transport.recovering = false;
    expect(splashStatus(all).reason).toBe('status_stale');
    all.transport.status_stale = false;
    expect(splashStatus(all).reason).toBe('not_admitting');
  });

  test('a not-ready body is never Loading: a closing transport or a missing metal block does not admit', () => {
    const closing = clone(IDLE);
    Object.assign(closing, { ready: false }); closing.transport.ready = false;
    expect(splashStatus(closing)).toMatchObject({ state: 'degraded', reason: 'not_admitting' });
    const { metal: _, ...noMetal } = clone(IDLE);
    expect(splashStatus({ ...noMetal, ready: false })).toMatchObject({ reason: 'not_admitting', params: { metalUnhealthy: true } });
  });

  test('a body that is not Splash is unsupported_contract', () => {
    for (const body of [null, [], {}, { ready: 'yes' }, { error: 'Unexpected endpoint or method. (GET /status)' }])
      expect(splashStatus(body)).toEqual({ state: 'degraded', reason: 'unsupported_contract', params: {} });
  });
});

describe('readings over every fixture', () => {
  test.each(FIXTURES.map(item => [`${item.version} ${item.variant}`, item] as const))('%s round-trips and stays clean', (name, { body }) => {
    const reading = splashReading(body, AT);
    expectClean(name, reading);
    expectRoundTrip(name, snapshotOf(reading));
    expect(reading.runtime.request).toBeNull();
    // Splash's Metal allocation is its own figure, never process or model memory.
    expect(Object.keys(reading.runtime.memory).every(key => key === 'metalBytes' || key === 'metalPeakBytes')).toBe(true);
  });

  test('stale and recovering bodies keep their totals but derive no activity', () => {
    for (const variant of ['recovering', 'status-stale', 'stale-no-snapshot']) {
      const { runtime, capabilities } = splashReading(status(variant), AT);
      expect(runtime).toMatchObject({ phase: 'unknown', server: { active: null, queued: null } });
      expect(capabilities['server.requests']).toBeUndefined();
      expect(runtime.catalog.map(item => item.loaded)).toEqual([null]);
    }
    expect(splashReading(status('recovering'), AT).runtime.server.histograms?.ttftMs).toEqual({ p50: 1_800.991797, p95: 65_083.54281, n: 55, window: 'native-last-4096' });
    const bare = splashReading(status('stale-no-snapshot'), AT);
    expect(bare.runtime.server).toEqual({ active: null, queued: null });
    expect(bare.runtime.memory).toEqual({});
    expect(Object.keys(bare.capabilities).sort()).toEqual(['server.catalog', 'server.completions']);
  });

  test('ready: counts, native latency, Metal memory and the catalog entry', () => {
    const reading = splashReading(status('ready-idle'), AT);
    expect(reading.runtime).toEqual({ sampledAt: AT, phase: 'idle', request: null,
      server: { active: 0, queued: 0, averages: { decodeTps: 57.702_158_2, prefillTps: 513.801_740_6, requestsTotal: 53, failedTotal: 0 },
        histograms: { ttftMs: { p50: 1_720.490_612, p95: 65_083.542_81, n: 54, window: 'native-last-4096' },
          itlMs: { p50: 18.080_874_12, p95: 31.095_577_05, n: 4_096, window: 'native-last-4096' } } },
      memory: { metalBytes: 19_498_131_456, metalPeakBytes: 20_010_885_120 }, residency: [], slots: [],
      catalog: [{ name: MODEL, format: 'splash', loaded: true, contextWindowTokens: 131_072, vision: false, inputModalities: ['text'] }], engines: [] });
    expect(reading.capabilities).toEqual({
      'server.requests': { scope: 'server', basis: 'derived' }, 'server.averages': { scope: 'server', basis: 'reported' },
      'server.latency': { scope: 'server', basis: 'reported' }, 'server.memory.metal': { scope: 'server', basis: 'reported' },
      'server.catalog': { scope: 'server', basis: 'reported' }, 'server.completions': { scope: 'server', basis: 'derived' } });
    expect(reading.identity).toEqual({});
    expect(reading.generationKey).toMatch(/^[0-9a-f]{8}$/);
  });

  test('activity: running, queued and HTTP-held requests', () => {
    expect(splashReading(status('decoding'), AT).runtime).toMatchObject({ phase: 'processing', server: { active: 2, queued: 0 } });
    expect(splashReading(status('memory-critical'), AT).runtime).toMatchObject({ phase: 'queued', server: { active: 0, queued: 1 } });
    const prefill = busy(false);
    Object.assign(prefill.scheduler, { decoding: 0, prefilling: 1 });
    expect(splashReading(prefill, AT).runtime).toMatchObject({ phase: 'prefill', server: { active: 1, queued: 0 } });
    expect(splashReading(busy(true), AT).runtime).toMatchObject({ phase: 'decode', server: { active: 1, queued: 0 } });
    // Preparing or still streaming: HTTP admission holds it while the engine has nothing.
    const preparing = clone(IDLE);
    preparing.http.requests.active = 1;
    expect(splashReading(preparing, AT).runtime).toMatchObject({ phase: 'processing', server: { active: 1, queued: 0 } });
    const partial = clone(IDLE);
    delete partial.requests.submitted;
    expect(splashReading(partial, AT).runtime).toMatchObject({ phase: 'unknown', server: { active: null, queued: null } });
  });

  test('empty native windows and token-less rates are left out, not shown as 0', () => {
    const fresh = clone(status('ready-after-crash'));
    Object.assign(fresh.metrics, { ttft_ms: { p50: 0, p95: 0, samples: 0 }, itl_ms: { p50: 0, p95: 0, samples: 0 },
      decode_output_tokens: 0, decode_tokens_per_second: 0, prefill_input_tokens: 0, prefill_tokens_per_second: 0 });
    const { runtime, capabilities } = splashReading(fresh, AT);
    expect(runtime.server.histograms).toBeUndefined();
    expect(runtime.server.averages).toEqual({ requestsTotal: 2, failedTotal: 0 });
    expect(capabilities['server.latency']).toBeUndefined();
  });

  test('a peak below the current allocation is not a peak', () => {
    const body = clone(IDLE);
    body.memory_actual.peak_bytes = body.memory_actual.current_bytes - 1;
    expect(splashReading(body, AT).runtime.memory).toEqual({ metalBytes: 19_498_131_456 });
  });

  test('the generation key follows the process, the engine and the model, and never carries them', () => {
    const key = (body: Json) => splashReading(body, AT).generationKey;
    const restarted = clone(IDLE), other = clone(IDLE), model = clone(IDLE);
    restarted.transport.restarts = 1; other.instance.id = 'another'; model.instance.model = 'publisher/Other-8B';
    expect(new Set([key(IDLE), key(restarted), key(other), key(model)]).size).toBe(4);
    expect(key(busy(true))).toBe(key(IDLE));
  });
});

describe('Splash 1.1 feature detection and catalog chips', () => {
  test('1.1 is told from 1.0.2 by vision, input_modalities and chat_template', () => {
    for (const { version, variant, body } of FIXTURES) expect(isSplash11(body), `${version} ${variant}`).toBe(version !== '1.0.2');
    expect(isSplash11({ ready: true, chat_template: { later_system: 'native' } })).toBe(true);
  });

  test('vision chips come only from 1.1 fields, and agree with /v1/models without reading it', () => {
    expect(splashReading(status('vision'), AT).runtime.catalog).toEqual([{ name: MODEL, format: 'splash', loaded: true,
      contextWindowTokens: 131_072, vision: true, inputModalities: ['text', 'image', 'pdf'] }]);
    for (const [variant, models] of [['vision', 'vision'], ['ready-idle', 'language-only']] as const) {
      const [entry] = splashReading(status(variant), AT).runtime.catalog, [listed] = load('1.1.0', `v1-models.${models}.json`).data;
      expect([entry!.name, entry!.vision, entry!.inputModalities, entry!.contextWindowTokens])
        .toEqual([listed.id, listed.vision, listed.input_modalities, listed.context_length]);
    }
    for (const variant of ['ready-idle', 'decoding', 'recovering']) {
      const [entry] = splashReading(status(variant, '1.0.2'), AT).runtime.catalog;
      expect(entry).toEqual({ name: load('1.0.2', 'v1-models.default.json').data[0].id, format: 'splash',
        loaded: variant === 'recovering' ? null : true, contextWindowTokens: 131_072 });
    }
  });

  test('unknown modalities are dropped and repeats collapse', () => {
    const body = clone(status('vision'));
    body.input_modalities = ['text', 'video', 'image', 'image', 7];
    expect(splashReading(body, AT).runtime.catalog[0]!.inputModalities).toEqual(['text', 'image']);
  });
});

describe('completions: the Δ = 1 rule (SPIKES S7)', () => {
  test('Δ=1 fixture pair: one derived per-request TTFT of 412.5 ms, with its own prefill and decode', () => {
    const draft = splashCompletion(status('delta1-before'), status('delta1-after'), AT);
    expect(draft).toEqual({ finishedAt: AT, startedAt: null, model: MODEL, basis: 'derived', overlapped: false, ttftMs: 412.5,
      prefillMs: 870.708, prefillTps: 514.524, decodeTps: 54.054 });
    expectRoundTrip('delta1', snapshotOf(splashReading(status('delta1-after'), AT), [draft!]));
  });

  test('Splash 1.2 renamed latency.ttft to latency.http_ttft (status schema 6): the Δ=1 pair still derives 412.5 ms', () => {
    const renamed = (name: string) => {
      const body = status(name), { ttft, ...stages } = body.latency;
      body.latency = { ...stages, http_ttft: ttft };
      return body;
    };
    const draft = splashCompletion(renamed('delta1-before'), renamed('delta1-after'), AT);
    expect(draft).toEqual({ finishedAt: AT, startedAt: null, model: MODEL, basis: 'derived', overlapped: false, ttftMs: 412.5,
      prefillMs: 870.708, prefillTps: 514.524, decodeTps: 54.054 });
    // Without either histogram there is still a completion, but no TTFT is invented.
    const bare = (name: string) => { const body = status(name); delete body.latency; return body; };
    expect(splashCompletion(bare('delta1-before'), bare('delta1-after'), AT)?.ttftMs).toBeUndefined();
  });

  test('Splash 1.2.0 captured Δ=1 pair: latency.http_ttft derives one per-request TTFT of 207.117 ms', () => {
    const before = status('delta1-before', '1.2.0'), done = status('delta1-after', '1.2.0');
    expect(done.latency.ttft).toBeUndefined();
    const draft = splashCompletion(before, done, AT);
    expect(draft).toEqual({ finishedAt: AT, startedAt: null, model: MODEL, basis: 'derived', overlapped: false, ttftMs: 207.117,
      prefillMs: 125.708, prefillTps: 167.053, decodeTps: 29.017 });
    expectRoundTrip('1.2.0 delta1', snapshotOf(splashReading(done, AT), [draft!]));
    // Mid-reply, the first token is counted but the request has not finished: no completion yet.
    expect(splashCompletion(before, status('decoding', '1.2.0'), AT)).toBeNull();
  });

  test('Δ=2 fixture pair: an aggregate step, with no per-request TTFT (the 944.75 ms mean is withheld)', () => {
    const draft = splashCompletion(status('delta2-before'), status('delta2-after'), AT);
    expect(draft).toEqual({ finishedAt: AT, startedAt: null, model: MODEL, basis: 'derived', overlapped: true, aggregateOf: 2 });
    expectRoundTrip('delta2', snapshotOf(splashReading(status('delta2-after'), AT), [draft!]));
  });

  test('negative controls: nothing finished, an engine restart, stale copies and foreign bodies derive nothing', () => {
    expect(splashCompletion(status('ready-idle'), status('decoding'), AT)).toBeNull();
    expect(splashCompletion(status('recovering'), status('ready-after-crash'), AT)).toBeNull();
    expect(splashCompletion(status('delta1-before'), status('status-stale'), AT)).toBeNull();
    const replaced = after(IDLE, { submitted: 1, completed: 1, ttftMs: [400] });
    replaced.instance.id = 'a-new-process';
    expect(splashCompletion(IDLE, replaced, AT)).toBeNull();
    expect(splashCompletion({}, status('delta1-after'), AT)).toBeNull();
  });

  test('anything else in the span withholds per-request values', () => {
    const one = { submitted: 1, completed: 1, ttftMs: [400] };
    const cases: Array<[string, Json, Json, Partial<CompletionDraft>]> = [
      // Another request is running at the second read: its first token could be the one counted.
      ['active after', IDLE, after(IDLE, { ...one, submitted: 2, active: 1 }), { overlapped: true }],
      ['two active before', after(IDLE, { submitted: 2, active: 2 }), after(IDLE, { submitted: 2, completed: 1, cancelled: 1, ttftMs: [400] }), { overlapped: true }],
      ['cancelled in span', IDLE, after(IDLE, { submitted: 2, completed: 1, cancelled: 1, ttftMs: [400] }), { overlapped: true }],
      ['failed in span', IDLE, after(IDLE, { submitted: 2, completed: 1, failed: 1, ttftMs: [400] }), { overlapped: true }],
      ['queued before', after(IDLE, { submitted: 1, queued: 1 }), after(IDLE, one), { overlapped: true }],
      ['three at once', IDLE, after(IDLE, { submitted: 3, completed: 3, ttftMs: [1, 2, 3] }), { overlapped: true, aggregateOf: 3 }],
    ];
    for (const [name, before, later, expected] of cases) {
      const draft = splashCompletion(before, later, AT)!;
      expect(draft, name).toMatchObject(expected);
      for (const key of ['ttftMs', 'prefillMs', 'prefillTps', 'decodeTps']) expect(key in draft, `${name}: ${key}`).toBe(false);
    }
  });

  test('a request already running at the first read keeps its TTFT only when that token came in the span', () => {
    const early = splashCompletion(busy(false), after(IDLE, { submitted: 1, completed: 1, ttftMs: [650], tokens: [900, 1_800, 40, 800] }), AT);
    expect(early).toEqual({ finishedAt: AT, startedAt: null, model: MODEL, basis: 'derived', overlapped: false, ttftMs: 650 });
    const late = splashCompletion(busy(true), after(busy(true), { completed: 1, active: 0 }), AT);
    expect(late).toEqual({ finishedAt: AT, startedAt: null, model: MODEL, basis: 'derived', overlapped: false });
  });
});

describe('SplashCompletions: bracketing requests between idle reads', () => {
  const run = (steps: Array<[body: unknown, monotonic: number]>) => {
    const tracker = new SplashCompletions(), out: CompletionDraft[][] = [];
    for (const [body, monotonic] of steps) out.push(tracker.observe(body, AT + monotonic, monotonic));
    return out;
  };
  const first = busy(false), running = busy(true);
  const done = after(IDLE, { submitted: 1, completed: 1, ttftMs: [300], tokens: [2_000, 4_000, 120, 2_400] });

  test('a request longer than the poll: its TTFT and completion land in different reads, and still pair up', () => {
    const out = run([[IDLE, 0], [first, 1_000], [running, 2_000], [running, 3_000], [done, 4_000]]);
    expect(out.slice(0, 4)).toEqual([[], [], [], []]);
    expect(out[4]).toEqual([{ finishedAt: AT + 4_000, startedAt: null, model: MODEL, basis: 'derived', overlapped: false,
      ttftMs: 300, prefillMs: 4_000, prefillTps: 500, decodeTps: 50 }]);
  });

  test('a stale read inside the span moves nothing; a later idle read still closes it', () => {
    const stale = clone(running);
    Object.assign(stale.transport, { status_stale: true, status_age_ms: 400, error: 'x' });
    expect(run([[IDLE, 0], [running, 1_000], [stale, 2_000], [done, 3_000]]).at(-1)).toMatchObject([{ ttftMs: 300 }]);
  });

  test('joining mid-request: no TTFT from before Scope looked', () => {
    expect(run([[running, 0], [done, 1_000]])).toEqual([[], [{ finishedAt: AT + 1_000, startedAt: null, model: MODEL,
      basis: 'derived', overlapped: false }]]);
  });

  test('an unwatched gap, a restart or a foreign body restarts the bracket without a completion', () => {
    expect(run([[IDLE, 0], [done, SPLASH_GAP_MS + 1]])).toEqual([[], []]);
    expect(run([[status('recovering'), 0], [status('ready-after-crash'), 30_000], [after(status('ready-after-crash'), { submitted: 1, completed: 1, ttftMs: [500] }), 31_000]])
      .at(-1)).toMatchObject([{ ttftMs: 500, overlapped: false }]);
    expect(run([[status('delta1-before'), 0], [status('ready-after-crash'), 1_000]])).toEqual([[], []]);
    expect(run([[IDLE, 0], [{ error: 'Unexpected endpoint or method.' }, 1_000], [done, 2_000]])).toEqual([[], [], []]);
  });

  test('several requests between idle reads are one aggregate step', () => {
    const two = after(IDLE, { submitted: 2, completed: 2, ttftMs: [300, 500] });
    expect(run([[IDLE, 0], [running, 1_000], [two, 2_000], [two, 3_000]])).toEqual([[], [],
      [{ finishedAt: AT + 2_000, startedAt: null, model: MODEL, basis: 'derived', overlapped: true, aggregateOf: 2 }], []]);
  });
});

/** A fake connection: `/status` answers from `replies` in turn; every GET is logged. */
const adapterWith = (replies: Array<Partial<RuntimeReply> | Error | Promise<Partial<RuntimeReply>>>) => {
  const paths: string[] = [], clock = { now: AT, monotonic: 0 };
  const context = {
    connection: { id: 'splash', port: 8000 }, config: {} as never, fetchImpl: (async () => { throw new Error('no fetch'); }) as never,
    exec: async () => { throw new Error('no exec'); }, getText: async () => { throw new Error('no text GET'); },
    get: async (path: string) => {
      paths.push(path);
      const reply = await replies[Math.min(paths.length - 1, replies.length - 1)]!;
      if (reply instanceof Error) throw reply;
      return { status: 200, body: null, routeMissing: false, ...reply } as RuntimeReply;
    },
    now: () => clock.now, monotonic: () => clock.monotonic, timeoutMs: 3_000, budgetMs: 2_000,
  } satisfies AdapterContextV2;
  return { adapter: splashDescriptor.create(context), paths, clock };
};
const READ = { deadline: AT + 2_000, tier: 'full', detail: true } as const;

describe('the adapter', () => {
  test('reports live server rates during decoding, preserves unknown request attribution and does not fabricate a completion', async () => {
    const running = busy(true), next = after(running, { tokens: [0, 0, 60, 500] }), later = after(next, { tokens: [0, 0, 60, 500] });
    const { adapter, paths, clock } = adapterWith([{ body: running }, { body: next }, { body: later }, { body: IDLE }]);
    const first = await adapter.read(READ);
    expect(first.runtime.server.rates).toBeUndefined();
    expect(first.capabilities['server.rates']).toBeUndefined();
    clock.now += 1_000; clock.monotonic += 1_000;
    expect((await adapter.read(READ)).runtime.server.rates).toBeUndefined();
    clock.now += 1_000; clock.monotonic += 1_000;
    const live = await adapter.read(READ);
    expect(live.runtime.server.rates).toEqual({ decodeTps: 120, windowMs: 2_000 });
    expect(live.capabilities['server.rates']).toEqual({ scope: 'server', basis: 'derived' });
    expect(live.runtime.request).toBeNull();
    expect(live.completions).toEqual([]);
    expect(live.runtime.server.averages).toEqual(first.runtime.server.averages);
    expectRoundTrip('live native decode', snapshotOf(live));
    clock.now += 1_000; clock.monotonic += 1_000;
    const idle = await adapter.read(READ);
    expect(idle.runtime.server.rates).toBeUndefined();
    expect(idle.capabilities['server.rates']).toBeUndefined();
    expect(paths).toEqual(['/status', '/status', '/status', '/status']);
  });

  test('a failed poll clears only the live-rate baseline before sampling resumes', async () => {
    const running = busy(true), next = after(running, { tokens: [0, 0, 60, 500] }), later = after(next, { tokens: [0, 0, 60, 500] });
    for (const failure of [new HttpFailure('runtime_unreachable', 'refused'), { status: 500 }]) {
      const { adapter, clock } = adapterWith([{ body: running }, failure, { body: next },
        { body: later }, { body: after(later, { tokens: [0, 0, 60, 500] }) }]);
      await adapter.read(READ);
      clock.monotonic += 1_000;
      await expect(adapter.read(READ)).rejects.toBeInstanceOf(HttpFailure);
      clock.monotonic += 1_000;
      expect((await adapter.read(READ)).runtime.server.rates).toBeUndefined();
      clock.monotonic += 1_000;
      expect((await adapter.read(READ)).runtime.server.rates).toBeUndefined();
      clock.monotonic += 1_000;
      expect((await adapter.read(READ)).runtime.server.rates).toEqual({ decodeTps: 120, windowMs: 2_000 });
    }
  });

  test('disposing the adapter drops the live-rate baseline', async () => {
    const running = busy(true), next = after(running, { tokens: [0, 0, 60, 500] });
    const { adapter, clock } = adapterWith([{ body: running }, { body: next }]);
    await adapter.read(READ); adapter.dispose(); clock.monotonic += 1_000;
    expect((await adapter.read(READ)).runtime.server.rates).toBeUndefined();
  });

  test('a late overlapping response cannot rewind the recent window', async () => {
    const running = busy(true), next = after(running, { tokens: [0, 0, 60, 500] }), later = after(next, { tokens: [0, 0, 60, 500] });
    let release!: (reply: Partial<RuntimeReply>) => void;
    const gate = new Promise<Partial<RuntimeReply>>(resolve => { release = resolve; });
    const { adapter, clock } = adapterWith([gate, { body: next }, { body: later }, { body: after(later, { tokens: [0, 0, 60, 500] }) }]);
    const pending = adapter.read(READ);
    clock.monotonic = 1_000;
    expect((await adapter.read(READ)).runtime.server.rates).toBeUndefined();
    clock.monotonic = 1_500; release({ body: running });
    expect((await pending).runtime.server.rates).toBeUndefined();
    clock.monotonic = 2_000;
    expect((await adapter.read(READ)).runtime.server.rates).toBeUndefined();
    clock.monotonic = 3_000;
    expect((await adapter.read(READ)).runtime.server.rates).toEqual({ decodeTps: 120, windowMs: 2_000 });
  });

  test('a response fetched before disposal cannot restore the cleared baseline', async () => {
    const running = busy(true), next = after(running, { tokens: [0, 0, 60, 500] }), later = after(next, { tokens: [0, 0, 60, 500] });
    let release!: (reply: Partial<RuntimeReply>) => void;
    const gate = new Promise<Partial<RuntimeReply>>(resolve => { release = resolve; });
    const { adapter, clock } = adapterWith([gate, { body: next }, { body: later }, { body: after(later, { tokens: [0, 0, 60, 500] }) }]);
    const pending = adapter.read(READ); adapter.dispose();
    clock.monotonic = 1_000; release({ body: running });
    expect((await pending).runtime.server.rates).toBeUndefined();
    clock.monotonic = 2_000;
    expect((await adapter.read(READ)).runtime.server.rates).toBeUndefined();
    clock.monotonic = 3_000;
    expect((await adapter.read(READ)).runtime.server.rates).toBeUndefined();
    clock.monotonic = 4_000;
    expect((await adapter.read(READ)).runtime.server.rates).toEqual({ decodeTps: 120, windowMs: 2_000 });
  });

  test('reads GET /status only: never /metrics or /v1/models, and runs no exec', async () => {
    const { adapter, paths } = adapterWith([{ body: IDLE }, { body: busy(true) }, { body: status('delta1-after') }]);
    for (let index = 0; index < 3; index += 1) await adapter.read(READ);
    expect(await adapter.identity()).toBe(true);
    expect(paths).toEqual(['/status', '/status', '/status', '/status']);
  });

  test('completions come out of successive reads', async () => {
    const { adapter, clock } = adapterWith([{ body: status('delta1-before') }, { body: status('delta1-after') }]);
    expect((await adapter.read(READ)).completions).toEqual([]);
    clock.now += 1_000; clock.monotonic += 1_000;
    const reading = await adapter.read(READ);
    expect(reading.completions).toMatchObject([{ finishedAt: AT + 1_000, ttftMs: 412.5, basis: 'derived', overlapped: false }]);
    expectClean('adapter', reading);
  });

  test('while recovering, Splash is read at most once every 30 s, identity checks included', async () => {
    const { adapter, paths, clock } = adapterWith([{ body: status('recovering') }, { body: status('ready-after-crash') }]);
    const first = await adapter.read(READ);
    expect(first.status).toMatchObject({ state: 'recovering', params: { retryInMs: SPLASH_RECOVERING_CACHE_MS } });
    clock.now += 12_000; clock.monotonic += 12_000;
    const held = await adapter.read(READ);
    expect(await adapter.identity()).toBe(true);
    expect(paths).toEqual(['/status']);
    expect(held).toEqual({ ...first, status: { ...first.status, params: { ...first.status.params, retryInMs: 18_000 } } });
    expect(splashDescriptor.cadence({ activity: false, tier: 'glance', recovering: true })).toBe(SPLASH_RECOVERING_CACHE_MS);
    clock.now += 18_000; clock.monotonic += 18_000;
    expect((await adapter.read(READ)).status.state).toBe('ready');
    expect(paths).toEqual(['/status', '/status']);
  });

  test('HTTP outcomes: a foreign 200 or a missing route reads as unsupported; auth and other failures throw', async () => {
    for (const reply of [{ body: { status: 'healthy' } }, { status: 404 }, { routeMissing: true, body: { error: 'Unexpected endpoint or method.' } }]) {
      const reading = await adapterWith([reply]).adapter.read(READ);
      expect(reading).toMatchObject({ status: { state: 'degraded', reason: 'unsupported_contract' }, capabilities: {}, completions: [] });
      expect(reading.generationKey).toBeUndefined();
    }
    const denied = adapterWith([{ status: 401 }]).adapter.read(READ);
    await expect(denied).rejects.toBeInstanceOf(HttpFailure);
    await expect(denied).rejects.toMatchObject({ reason: 'authentication_failed', status: 401 });
    await expect(adapterWith([{ status: 500 }]).adapter.read(READ)).rejects.toMatchObject({ reason: 'runtime_unreachable', status: 500 });
    const refused = new HttpFailure('runtime_unreachable', 'refused');
    await expect(adapterWith([refused]).adapter.read(READ)).rejects.toBe(refused);
    // A Splash body under an error status is still Splash speaking.
    expect((await adapterWith([{ status: 503, body: status('metal-unhealthy') }]).adapter.read(READ)).status.reason).toBe('not_admitting');
  });

  test('identity: another runtime on the port is not Splash', async () => {
    expect(await adapterWith([{ body: { status: 'healthy', engine_pool: {} } }]).adapter.identity()).toBe(false);
    expect(await adapterWith([{ body: status('ready-idle', '1.0.2') }]).adapter.identity()).toBe(true);
  });
});

describe('the descriptor', () => {
  test('detection: high confidence for a Splash transport body, medium for the bare 1.6 rule', async () => {
    const step = async (body: unknown) => {
      for (const candidate of splashDescriptor.detect)
        if (await candidate.match({ status: 200, body: body as Json, routeMissing: false }, async () => { throw new Error('no follow'); })) return candidate.confidence;
      return null;
    };
    for (const { version, variant, body } of FIXTURES) expect(await step(body), `${version} ${variant}`).toBe('high');
    expect(await step({ ready: true })).toBe('medium');
    // A /status schema without a qualified corpus (Splash 1.2 is 6) still matches, but only at medium.
    expect(await step({ ...status('ready-idle', '1.2.0'), schema_version: 7 })).toBe('medium');
    for (const body of [null, {}, { ready: 1 }, { status: 'healthy' }, { model_loaded: true }]) expect(await step(body)).toBeNull();
    expect(splashDescriptor.detect.every(item => item.probe === '/status')).toBe(true);
  });

  test('hints: splash and splish by id or name, never a Bionic "Splash" engine', () => {
    const hint = splashDescriptor.hints;
    expect([hint('splash', ''), hint('splish', ''), hint(' Splash ', ''), hint('local-1', 'Splash (standalone)'), hint('mine', 'splish fork')])
      .toEqual([true, true, true, true, true]);
    expect([hint('bionic', 'Splash (Bionic)'), hint('lmstudio', 'Splash'), hint('omlx', 'Local oMLX'), hint('splash-bionic', '')])
      .toEqual([false, false, false, false]);
  });

  test('cadence and declared capabilities', () => {
    expect([true, false].map(activity => splashDescriptor.cadence({ activity, tier: 'full', recovering: false }))).toEqual([1_000, 2_000]);
    expect(splashDescriptor.identityEveryMs).toBe(60_000);
    expect(splashDescriptor.capabilities).toEqual([
      { key: 'server.requests', basis: 'derived' }, { key: 'server.averages', basis: 'reported' }, { key: 'server.rates', basis: 'derived' },
      { key: 'server.latency', basis: 'reported' },
      { key: 'server.memory.metal', basis: 'reported' }, { key: 'server.catalog', basis: 'reported' }, { key: 'server.completions', basis: 'derived' }]);
  });
});
