import { describe, expect, test } from 'bun:test';
import { HostRequestError, type HostClient } from '@openchamber/sdk';
import { baselineKey as panelBaselineKey } from '../panel/history/baselines.ts';
import { KEYS } from '../panel/history/ledger-schema.ts';
import { SCOPE_HEADER, SCOPE_TEXT_MAX_CHARS } from '../panel/share/scope.ts';
import { parseSnapshotQuery } from '../src/contract/query.ts';
import { ROUTES } from '../src/contract/version.ts';
import { version } from '../package.json';
import { isConnectionId } from '../src/contract/guards.ts';
import { parseSnapshotV2 } from '../src/contract/snapshot.ts';
import { mockBody } from '../panel/testing/mock-states.ts';
import { PROVIDER, resolveScope, SCOPE_ERRORS, SCOPE_PATH, SCOPE_QUERY } from './scope.ts';
import { baselineKey, USUAL_KEYS, usualFor } from './usual.ts';

const AT = 1_790_690_700_000;
const MODEL = 'CANARY-MODEL-llama7-99b';
const cap = (key: string, basis = 'reported') => [key, { scope: key.slice(0, key.indexOf('.')), basis }];
const reply = (patch: object = {}) => ({ seq: 3, finishedAt: AT - 5_000, startedAt: AT - 9_000, model: MODEL, basis: 'reported', promptTokens: 20_000,
  cachedTokens: 16_000, outputTokens: 900, decodeTps: 30, prefillTps: 900, ttftMs: 600, overlapped: false, host: {}, ...patch });
const snapshot = (item: object | null = reply()) => ({
  contractVersion: 2, serverNow: AT, service: { version: '2.0.0', instance: '5c1e0a7b' },
  connection: { id: 'bionic', label: 'Splash (Bionic)', runtime: 'lmstudio', engine: 'splash', host: 'bionic', generation: 2,
    detection: { basis: 'hint', confidence: 'high' }, choices: [] },
  status: { state: 'ready', reason: null, params: {} },
  capabilities: Object.fromEntries([cap('server.completions'), cap('host.pressure')]),
  runtime: { phase: 'idle', request: null, server: { active: null, queued: null }, memory: {}, residency: [], slots: [], catalog: [], engines: [] },
  host: { sampledAt: AT, mac: { sampledAt: AT, pressureLevel: 1 } },
  completions: { instance: '5c1e0a7b', cursor: 3, reset: false, items: item ? [item] : [] },
  marksHead: 0, alerts: [], alertLog: [], lease: { leader: false, epoch: 0, ttlMs: 12_000, leaderSurface: null }, nextPollMs: 3_000,
});
// decode keys by the prompt + output bucket (20,900 → 1), prefill and TTFT by the uncached bucket (4,000 → 0); modelRef = index 1.
const STORE = { v: 2, computedAt: AT - 60_000, entries: [
  ['decodeTps|lmstudio|1|1', 40, 44, 34], ['prefillTps|lmstudio|1|0', 1_000, 1_200, 12], ['ttftMs|lmstudio|1|0', 400, 500, 4],
  ['decodeTps|lmstudio|0|1', 10, 11, 50],
] };
const MODELS = ['other-model', MODEL];

type Call = { method: string; args: unknown[] };
/** A host that only has what /scope may use: one serviceRequest and storage.get. Anything else throws (no subscriptions). */
const fakeHost = (response: { status: number; body: unknown } | Error, stored: Record<string, unknown> | Error = { [KEYS.baseline]: STORE, [KEYS.models]: MODELS }) => {
  const calls: Call[] = [];
  const storage = new Proxy({
    get: async (key: string) => { calls.push({ method: 'storage.get', args: [key] }); if (stored instanceof Error) throw stored; return stored[key]; },
  }, { get: (target, name) => { if (name in target) return target[name as keyof typeof target]; throw new Error(`storage.${String(name)} is not allowed`); } });
  const host = new Proxy({
    serviceRequest: async (request: unknown) => { calls.push({ method: 'serviceRequest', args: [request] }); if (response instanceof Error) throw response; return response; },
    storage,
  }, { get: (target, name) => { if (name in target) return target[name as keyof typeof target]; throw new Error(`host.${String(name)} is not allowed`); } });
  return { host: host as unknown as Pick<HostClient, 'serviceRequest' | 'storage'>, calls };
};
const ok = (body: unknown = snapshot()) => ({ status: 200, body: JSON.stringify(body) });

describe('resolveScope', () => {
  test('one background read exports both Splash stage windows without inventing request context', async () => {
    const body = parseSnapshotV2(mockBody('splash-decode', { now: AT }))!;
    body.runtime.phase = 'processing';
    body.runtime.server.rates = { decodeTps: 43.8, windowMs: 4000, promptTps: 1200, promptWindowMs: 2350 };
    body.runtime.server.averages!.prefillTps = 1500;
    const { host, calls } = fakeHost(ok(body));
    const item = await resolveScope(host, { command: 'scope', args: 'CANARY private text' }, () => AT);
    expect(item!.text).toContain('recent prefill engine speed over 2.35 s (input/native prefill time) 1200 tok/s (derived)');
    expect(item!.text).toContain('recent engine speed over 4 s (output/native decode time) 43.8 tok/s (derived)');
    expect(item!.text).toContain('prefill average since engine start 1500 tok/s (reported)');
    expect(item!.text).not.toContain('Current request:');
    expect(item!.text).not.toContain('CANARY');
    expect(calls.filter(call => call.method === 'serviceRequest')).toHaveLength(1);
    const held = await resolveScope(fakeHost(ok(body)).host, { command: 'scope', args: '' }, () => AT + 30_000);
    expect(held!.text).not.toContain('recent prefill engine speed');
    expect(held!.text).not.toContain('recent engine speed');
    expect(held!.text).toContain('average since engine start');
  });
  test('the saved connection, one /v2/snapshot?surface=background read and two storage gets: no frame, cursor, marks or verdicts, no writes', async () => {
    const { host, calls } = fakeHost(ok());
    const item = await resolveScope(host, { command: 'scope', args: '' }, () => AT);
    expect(calls).toEqual([
      { method: 'storage.get', args: ['connection.selection'] },
      { method: 'serviceRequest', args: [{ method: 'GET', path: '/v2/snapshot', query: { surface: 'background', tier: 'glance' } }] },
      { method: 'storage.get', args: ['baseline.v2'] }, { method: 'storage.get', args: ['ledger.v2.models'] },
    ]);
    expect(item).toEqual({ providerId: 'mlx-scope', id: 'mlx-scope-diagnostics', title: 'MLX Scope diagnostics',
      url: `https://github.com/mikebuckets171/mlx-scope-openchamber/blob/${version.includes('-') ? 'main' : `v${version}`}/README.md#scope-diagnostics`,
      text: expect.any(String) });
    const lines = item!.text!.split('\n');
    expect(lines[0]).toBe(`${SCOPE_HEADER}.`);
    expect(lines).toContain('Runtime: Splash via Bionic, status ready, phase idle, reading 0 ms old');
    expect(lines).toContain('Last finished reply (5 s ago, reported): decode 30 tok/s, prefill 900 tok/s, first token 600 ms, context 8k–32k tokens, 80% cached');
    expect(lines).toContain('vs usual: decode 0.75× (n=34), prefill 0.9× (n=12)');
    expect(lines).toContain('This Mac: memory pressure normal');
    expect(item!.text!.length).toBeLessThanOrEqual(SCOPE_TEXT_MAX_CHARS);
  });
  test('the service reads the query as a background frame on the glance tier: never a lease candidate', () => {
    const query = parseSnapshotQuery(new URLSearchParams(SCOPE_QUERY));
    expect(query).toEqual({ surface: 'background', tier: 'glance', marks: [], attrs: [] });
    expect(SCOPE_PATH).toBe(ROUTES.snapshot);
  });
  test('class A and B canaries: typed arguments, model names and the model dictionary never reach the chip', async () => {
    const args = 'CANARY-ARGS /Users/fixture/secret project sk-CANARY-7f3a-key';
    const { host } = fakeHost(ok(snapshot(reply({ model: MODEL }))), { [KEYS.baseline]: STORE, [KEYS.models]: [MODEL, 'CANARY-dictionary-model'] });
    const item = await resolveScope(host, { command: 'scope', args }, () => AT);
    const serialized = JSON.stringify(item);
    for (const canary of ['CANARY', MODEL, 'llama7', '/Users/', 'sk-CANARY', 'secret project']) expect(serialized).not.toContain(canary);
  });
  test('a runtime that is down still gets a chip; its state is the diagnosis', async () => {
    const down = { ...snapshot(null), status: { state: 'failing', reason: 'runtime_unreachable', params: { port: 1234 } } };
    const item = await resolveScope(fakeHost(ok(down)).host, { command: 'scope', args: '' }, () => AT);
    expect(item!.text).toContain('status failing (runtime_unreachable)');
    expect(item!.text).not.toContain('1234');
  });
  test('unreadable storage keeps the chip and says so', async () => {
    const item = await resolveScope(fakeHost(ok(), new HostRequestError('HOST_REJECTED', 'no')).host, { command: 'scope', args: '' }, () => AT);
    expect(item!.text).toContain('vs usual: history unavailable');
  });
  test('a service that cannot answer is an error the host shows, never an empty chip', async () => {
    const fails = (response: Parameters<typeof fakeHost>[0]) => resolveScope(fakeHost(response).host, { command: 'scope', args: '' }, () => AT);
    await expect(fails(new HostRequestError('NOT_GRANTED', 'fixture detail'))).rejects.toThrow(SCOPE_ERRORS.approval);
    await expect(fails(new HostRequestError('DISABLED', 'fixture detail'))).rejects.toThrow(SCOPE_ERRORS.approval);
    await expect(fails(new HostRequestError('SERVICE_FAILED', 'fixture detail'))).rejects.toThrow(SCOPE_ERRORS.unreachable);
    await expect(fails(new Error('boom'))).rejects.toThrow(SCOPE_ERRORS.unreachable);
    await expect(fails({ status: 404, body: '{"error":"not_found"}' })).rejects.toThrow(SCOPE_ERRORS.mismatch);
    await expect(fails({ status: 200, body: '{"contractVersion":3}' })).rejects.toThrow(SCOPE_ERRORS.mismatch);
    await expect(fails({ status: 503, body: '{}' })).rejects.toThrow(SCOPE_ERRORS.unreachable);
    await expect(fails({ status: 200, body: '{not json' })).rejects.toThrow(SCOPE_ERRORS.unreachable);
    await expect(fails({ status: 200, body: '[]' })).rejects.toThrow(SCOPE_ERRORS.unreachable);
    for (const message of Object.values(SCOPE_ERRORS)) expect(message).not.toContain('fixture detail');
  });
});

describe('/scope reads the connection Scope watches', () => {
  const query = async (selection: unknown) => {
    const { host, calls } = fakeHost(ok(), { 'connection.selection': selection, [KEYS.baseline]: STORE, [KEYS.models]: MODELS });
    await resolveScope(host, { command: 'scope', args: '' }, () => AT);
    return (calls.find(call => call.method === 'serviceRequest')!.args[0] as { query: Record<string, string> }).query;
  };
  test('the restated provider rule is guards.ts isConnectionId', () => {
    for (const value of ['splash', 'a'.repeat(120), 'a'.repeat(121), '', 'bad\nid', 'del\u007f', 'omlx-2 (local)']) expect(PROVIDER.test(value)).toBe(isConnectionId(value));
  });
  test('a saved provider and runtime reach the query; Automatic, malformed or unreadable choices do not', async () => {
    expect(await query({ provider: 'splash', runtime: null })).toEqual({ surface: 'background', tier: 'glance', provider: 'splash' });
    expect(await query({ provider: '', runtime: 'ollama' })).toEqual({ surface: 'background', tier: 'glance', runtime: 'ollama' });
    expect(await query({ provider: 'bad\nid', runtime: 'not-a-runtime' })).toEqual({ surface: 'background', tier: 'glance' });
    expect(await query(undefined)).toEqual({ surface: 'background', tier: 'glance' });
  });
});

describe('vs usual for /scope', () => {
  test('keys, storage keys and buckets are the ledger and baseline ones', () => {
    expect(USUAL_KEYS).toEqual([KEYS.baseline, KEYS.models]);
    expect(baselineKey('ttftMs', 'ollama', 3, 4)).toBe(panelBaselineKey('ttftMs', { rt: 'ollama', modelRef: 3, bucket: 4 }));
  });
  test('only with n ≥ 5; per-request metrics skip overlapped, aggregate and estimate replies, TTFT also last-observed ones', () => {
    const usual = (patch: object, store: unknown = STORE, models: unknown = MODELS) => usualFor(snapshot(reply(patch)), store, models);
    expect(usual({}).map(item => [item.metric, Number(item.ratio.toFixed(3)), item.n])).toEqual([['decodeTps', 0.75, 34], ['prefillTps', 0.9, 12]]);
    expect(usual({ overlapped: true })).toEqual([]);
    expect(usual({ aggregateOf: 3 })).toEqual([]);
    expect(usual({ basis: 'estimate' })).toEqual([]);
    expect(usual({ model: 'not-in-dictionary' })).toEqual([]);
    expect(usual({}, { v: 1, entries: STORE.entries })).toEqual([]);
    expect(usual({}, STORE, { names: MODELS })).toEqual([]);
    const withTtft = { ...STORE, entries: [...STORE.entries.slice(0, 2), ['ttftMs|lmstudio|1|0', 400, 500, 20]] };
    expect(usual({}, withTtft).map(item => item.metric)).toEqual(['decodeTps', 'prefillTps', 'ttftMs']);
    expect(usual({ basis: 'last-observed' }, withTtft).map(item => item.metric)).toEqual(['decodeTps', 'prefillTps']);
    expect(usual({ cachedTokens: 30_000 }).map(item => item.metric)).toEqual(['decodeTps']);
    expect(usualFor(snapshot(null), STORE, MODELS)).toEqual([]);
  });
  test('decode is compared in the bucket the ledger files the reply under: prompt + output', () => {
    // 30,000 + 3,000 crosses 32,768: the ledger's replyRow files it in bucket 2, so /scope reads bucket 2, not the prompt's 1.
    const store = { ...STORE, entries: [...STORE.entries, ['decodeTps|lmstudio|1|2', 60, 66, 20]] };
    const decode = usualFor(snapshot(reply({ promptTokens: 30_000, outputTokens: 3_000 })), store, MODELS).find(item => item.metric === 'decodeTps');
    expect(decode).toEqual(expect.objectContaining({ ratio: 0.5, n: 20 }));
  });
});
