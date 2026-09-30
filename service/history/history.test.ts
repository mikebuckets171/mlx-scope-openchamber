import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Glob } from 'bun';
import { parseAlertLog, parseAlerts } from '../../src/contract/alerts.ts';
import type { Capabilities } from '../../src/contract/capabilities.ts';
import { MAX_COMPLETIONS, parseCompletionsV2 } from '../../src/contract/completion.ts';
import { classAKeys, MAX_BODY_CHARS } from '../../src/contract/guards.ts';
import type { HostV2 } from '../../src/contract/host.ts';
import type { UsageQuery } from '../../src/contract/query.ts';
import type { RequestV2, RuntimeV2, StatusV2 } from '../../src/contract/snapshot.ts';
import { parseTrendV2 } from '../../src/contract/trend.ts';
import type { UsageV2 } from '../../src/contract/usage.ts';
import { parseSystemSnapshot } from '../../src/system.ts';
import type { CompletionDraft } from '../core/adapter-v2.ts';
import { createScopeServer, unread, type Sources } from '../server.ts';
import { counterCompletion } from './completions.ts';
import { CADENCE_MEMORY_MS, HISTORY_SLOTS, historySources, ServiceHistory, type HistoryReading } from './history.ts';

const T = 1_790_690_700_000, INSTANCE = '5c1e0a7b', MODEL = 'Example-27B-4bit';
const ready: StatusV2 = { state: 'ready', reason: null, params: {} };
const OMLX: Capabilities = { 'request.decodeRate': { scope: 'request', basis: 'reported' }, 'request.prefillRate': { scope: 'request', basis: 'reported' },
  'server.requests': { scope: 'server', basis: 'reported' }, 'server.residency': { scope: 'server', basis: 'reported' },
  'server.completions': { scope: 'server', basis: 'last-observed' } };
const runtime = (phase: RuntimeV2['phase'], request: Partial<RequestV2> | null, active = request ? 1 : 0): RuntimeV2 => ({
  phase, request: request ? { model: MODEL, ...request } : null, server: { active, queued: 0 }, memory: {},
  residency: [{ model: MODEL, phase, source: 'runtime' }], slots: [], catalog: [], engines: [],
});
const reading = (at: number, current: RuntimeV2, patch: Partial<HistoryReading> = {}): HistoryReading =>
  ({ at, kind: 'omlx', status: ready, capabilities: OMLX, runtime: current, ...patch });
const host = (at: number, pressureLevel: 1 | 2 | 4 = 1): HostV2 => ({ sampledAt: at, cpuFraction: 0.2, memUsedBytes: 30 * 2 ** 30,
  mac: { sampledAt: at, pressureLevel, swapUsedBytes: 2 ** 30 }, power: { sampledAt: at, field: 'all_power', chipW: 40, coverageFraction: 1 } });
const verdicts = new Map<number, NonNullable<ReturnType<Parameters<ServiceHistory['snapshot']>[1]['verdict']>>>();
const verdict = (seq: number) => verdicts.get(seq);

/** An oMLX request watched at 500 ms: 2 s prefill, 3 s decode, then idle. */
const session = (history: ServiceHistory, key: string, start: number, selection = { provider: 'omlx' }) => {
  for (let at = start; at <= start + 7_000; at += 500) {
    const offset = at - start;
    const current = offset < 2_000 ? runtime('prefill', { prefillFraction: offset / 2_000, elapsedMs: offset, prefillTps: 500, promptTokens: 1_000, cachedTokens: 0 })
      : offset < 5_000 ? runtime('decode', { outputTokens: (offset - 2_000) / 100, decodeTps: 25, elapsedMs: offset, promptTokens: 1_000, cachedTokens: 0 })
      : runtime('idle', null);
    history.record(key, reading(at, current), host(at), { now: at, pollMs: 500, selection });
  }
};

test('an oMLX request watched through the snapshot branch becomes one completion with its host co-factors', () => {
  const history = new ServiceHistory(INSTANCE);
  session(history, 'omlx\0auto', T);
  expect(history.head).toBe(1);
  const parts = history.snapshot('omlx\0auto', { leader: true, now: T + 7_000, verdict });
  expect(parts.completions).toEqual({ instance: INSTANCE, cursor: 1, reset: false, items: [{ seq: 1, finishedAt: T + 4_500, startedAt: T, model: MODEL,
    basis: 'last-observed', promptTokens: 1_000, cachedTokens: 0, outputTokens: 25, prefillMs: 2_000, decodeTps: 25, prefillTps: 500, overlapped: false,
    host: { pressureMax: 1, swapDeltaBytes: 0, energyJ: 180, powerCoverage: 1 } }] });
  expect(parseCompletionsV2(structuredClone(parts.completions), INSTANCE)).toEqual(parts.completions);
  // The same cached reading from another frame adds nothing.
  history.record('omlx\0auto', reading(T + 7_000, runtime('idle', null)), host(T + 7_000), { now: T + 7_200 });
  expect(history.snapshot('omlx\0auto', { since: 1, leader: false, now: T + 7_200, verdict }).completions.items).toEqual([]);
  verdicts.set(1, { attr: 'inferred', at: T + 7_100 });
  expect(history.snapshot('omlx\0auto', { since: 0, leader: false, now: T + 7_200, verdict }).completions.items[0]!.verdict).toEqual({ attr: 'inferred', at: T + 7_100 });
});

test('adapter drafts are kept only with their runtime\'s basis; inventory-only runtimes have no completions', () => {
  const history = new ServiceHistory(INSTANCE);
  const draft = (basis: CompletionDraft['basis'], at: number): CompletionDraft => ({ finishedAt: at, startedAt: null, model: MODEL, basis, overlapped: false });
  const splash = counterCompletion({ at: T, completed: 5, active: 0, queued: 0, model: MODEL, ttftCount: 5, ttftSumMs: 5_000 },
    { at: T + 2_000, completed: 6, active: 0, queued: 0, model: MODEL, ttftCount: 6, ttftSumMs: 5_400 })!;
  history.record('splash', reading(T + 2_000, runtime('idle', null), { kind: 'splash', completions: [splash, draft('reported', T + 2_000)] }), null, { now: T + 2_000 });
  history.record('bionic', reading(T + 2_000, runtime('idle', null), { kind: 'lmstudio', completions: [draft('reported', T + 1_000)] }), null, { now: T + 2_000 });
  history.record('ollama', reading(T + 2_000, runtime('idle', null), { kind: 'ollama', completions: [draft('reported', T + 1_000)] }), null, { now: T + 2_000 });
  // oMLX completions come from the watch alone.
  history.record('omlx', reading(T + 2_000, runtime('idle', null), { completions: [draft('last-observed', T + 1_000)] }), null, { now: T + 2_000 });
  const items = (key: string) => history.snapshot(key, { leader: false, now: T + 2_000, verdict }).completions.items;
  expect(items('splash')).toMatchObject([{ seq: 1, basis: 'derived', ttftMs: 400, host: {} }]);
  expect(items('bionic')).toMatchObject([{ seq: 2, basis: 'reported' }]);
  expect([items('ollama'), items('omlx'), items('never-read')]).toEqual([[], [], []]);
  expect(history.head).toBe(2);
});

test('/v2/trend finds the slot its selection last polled, samples only what capabilities allow, and follows the slowest viewer', () => {
  const history = new ServiceHistory(INSTANCE);
  session(history, 'omlx\0auto', T - 60_000);
  const trend = history.trend({ provider: 'omlx', windowMs: 900_000, series: ['decodeTps', 'prefillTps', 'active', 'cpuFraction', 'chipW'] }, T, []);
  expect(parseTrendV2(structuredClone(trend))).toEqual(trend);
  expect(Object.fromEntries(Object.entries(trend.series).map(([name, value]) => [name, value.basis])))
    .toEqual({ decodeTps: 'reported', prefillTps: 'reported', active: 'reported', cpuFraction: 'reported', chipW: 'estimate' });
  expect(trend.series.decodeTps!.buckets.flatMap(bucket => bucket ?? [])).toEqual([25, 25, 25]);
  expect(trend.gaps).toEqual([{ fromAt: T - 900_000, toAt: T - 60_000 }, { fromAt: T - 53_000, toAt: T }]);
  expect(history.trend({ provider: 'other', windowMs: 900_000, series: ['active'] }, T, []).gaps).toEqual([{ fromAt: T - 900_000, toAt: T }]);
  // A runtime without a decode-rate capability never puts a rate in the ring.
  const bare = new ServiceHistory(INSTANCE);
  bare.record('x', reading(T, runtime('decode', { decodeTps: 99, outputTokens: 5 }), { capabilities: {} }), null, { now: T, selection: {} });
  expect(bare.trend({ windowMs: 900_000, series: ['decodeTps', 'active'] }, T, []).series).toEqual({});
  // A status frame polling every 10 s keeps one segment.
  const glance = new ServiceHistory(INSTANCE);
  for (let at = T - 120_000; at <= T; at += 10_000) glance.record('x', reading(at, runtime('idle', null)), host(at), { now: at, pollMs: 10_000, selection: {} });
  expect(glance.trend({ windowMs: 900_000, series: ['active'] }, T, []).gaps).toEqual([{ fromAt: T - 900_000, toAt: T - 120_000 }]);
  expect(CADENCE_MEMORY_MS).toBeGreaterThan(10_000);
});

test('alerts are evaluated on every request and shown per slot, host alerts for all', () => {
  const history = new ServiceHistory(INSTANCE);
  const lost: StatusV2 = { state: 'failing', reason: 'runtime_unreachable', params: { port: 8001 } };
  history.record('omlx', reading(T, runtime('idle', null), {}), host(T, 4), { now: T });
  for (const at of [T + 1_000, T + 4_000, T + 7_000]) {
    history.record('omlx', reading(at, { ...runtime('unknown', null), server: { active: null, queued: null }, residency: [] }, { status: lost }), host(at, 4), { now: at });
  }
  const view = history.snapshot('omlx', { leader: true, now: T + 7_000, verdict });
  expect(view.alerts.map(alert => [alert.id, alert.toastSeq])).toEqual([['pressure-critical', 1], ['runtime-lost', undefined]]);
  expect(parseAlerts(structuredClone(view.alerts))).toEqual(view.alerts);
  expect(parseAlertLog(structuredClone(view.alertLog))).toEqual(view.alertLog);
  expect(history.snapshot('splash', { leader: false, now: T + 7_000, verdict }).alerts.map(alert => alert.id)).toEqual(['pressure-critical']);
});

test('at most 8 slots are kept; completions stay under the route limit at their maximum', () => {
  const history = new ServiceHistory(INSTANCE);
  for (let index = 0; index <= HISTORY_SLOTS; index += 1) history.record(`slot-${index}`, reading(T, runtime('idle', null)), null, { now: T });
  expect((history as unknown as { slots: Map<string, unknown> }).slots.size).toBe(HISTORY_SLOTS);
  const full = new ServiceHistory(INSTANCE), long = 'M'.repeat(256);
  const drafts = Array.from({ length: 200 }, (_, index): CompletionDraft => ({ finishedAt: T + index, startedAt: T - 60_000, model: long, basis: 'reported',
    promptTokens: 123_456_789, cachedTokens: 123_456_789, outputTokens: 123_456_789, ttftMs: 123_456.7, prefillMs: 123_456.7, decodeTps: 123.45, prefillTps: 12_345.67,
    overlapped: true }));
  full.record('bionic', reading(T + 500, runtime('idle', null), { kind: 'lmstudio', completions: drafts }), host(T + 500), { now: T + 500 });
  const completions = full.snapshot('bionic', { leader: true, now: T + 500, verdict: () => ({ attr: 'withheld', reason: 'overlap', at: T }) }).completions;
  expect(completions.items).toHaveLength(MAX_COMPLETIONS);
  expect(JSON.stringify(completions).length).toBeLessThan(MAX_BODY_CHARS / 3);
});

// Route tests: the history sources plugged into createScopeServer, as svc-2b will wire them.
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
});
const offline = unread(T);
const launch = async (history: ServiceHistory, readUsage?: (query: UsageQuery) => Promise<UsageV2>) => {
  const now = () => T;
  const sources: Sources = { read: async () => offline, system: async () => parseSystemSnapshot({ platform: 'darwin', sampledAt: T, memoryTotalGB: 48 })!,
    ...historySources(history, { now, ...readUsage ? { readUsage } : {} }) };
  const server = createScopeServer('test-token', sources, { version: '2.0.0-test', instance: INSTANCE, now, monotonic: () => 1_000 });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (path: string) => fetch(url + path, { headers: { Authorization: 'Bearer test-token' } });
};

test('/v2/trend serves the ring with the turn marks frames sent, without their tags', async () => {
  const history = new ServiceHistory(INSTANCE);
  session(history, 'omlx\0auto', T - 30_000);
  const request = await launch(history);
  expect((await request(`/v2/snapshot?provider=omlx&frame=0a0b0c0d&surface=panel&mark=started.${T - 29_000}.deadbeef,completed.${T - 23_000}.deadbeef`)).status).toBe(200);
  const response = await request('/v2/trend?provider=omlx&window=1800&series=decodeTps,active');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const text = await response.text(), trend = parseTrendV2(JSON.parse(text))!;
  expect(text).not.toContain('deadbeef');
  expect(classAKeys(JSON.parse(text))).toEqual([]);
  expect(trend).toMatchObject({ windowMs: 1_800_000, bucketMs: 10_000, serverNow: T, marks: [{ seq: 1, at: T - 29_000, phase: 'started' }, { seq: 2, at: T - 23_000, phase: 'completed' }] });
  expect(Object.keys(trend.series)).toEqual(['decodeTps', 'active']);
  expect((await request('/v2/trend?window=600')).status).toBe(400);
  expect((await request('/v2/usage?provider=omlx')).status).toBe(501);
});

test('/v2/usage reads through the 5 min cache', async () => {
  let reads = 0;
  const usage: UsageV2 = { contractVersion: 2, serverNow: T, available: true, range: '30d', cachedAt: T, basis: 'reported', granularity: 'day',
    buckets: [], totals: { requests: 0, promptTokens: 0, outputTokens: 0 }, models: [] };
  const request = await launch(new ServiceHistory(INSTANCE), async () => { reads += 1; return usage; });
  for (let index = 0; index < 3; index += 1) {
    const response = await request('/v2/usage?provider=omlx&range=30d');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(usage);
  }
  expect(reads).toBe(1);
  expect((await request('/v2/usage?range=1y')).status).toBe(400);
});

test('the history modules write nothing, spawn nothing and open no sockets', () => {
  const root = new URL('.', import.meta.url).pathname;
  const sources = [...new Glob('*.ts').scanSync(root)].filter(file => !file.endsWith('.test.ts'));
  expect(sources.sort()).toEqual(['alerts.ts', 'completions.ts', 'history.ts', 'ring.ts', 'usage-cache.ts']);
  for (const file of sources) expect(readFileSync(`${root}${file}`, 'utf8'), file).not.toMatch(/from 'node:|\bsetInterval\b|\bsetTimeout\b|\bfetch\(|process\./);
});
