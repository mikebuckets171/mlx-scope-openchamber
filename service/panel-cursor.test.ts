import { afterEach, expect, test } from 'bun:test';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SnapshotClient } from '../panel/data/client.ts';
import { ScopeState } from '../panel/state/scope-state.ts';
import { hostFromV1 } from '../src/contract/convert-v1.ts';
import { parseSystemSnapshot } from '../src/system.ts';
import type { CompletionSink, RuntimeReading } from './runtime-client.ts';
import { createScopeServer } from './server.ts';

// The panel's completion cursor against the real service: the two tracks agree on `since`, `cursor` and `reset`.
const NOW = 1_790_690_700_000;
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
});
const host = hostFromV1(parseSystemSnapshot({ platform: 'darwin', sampledAt: NOW - 500, memoryTotalGB: 48 }));
/** A slot whose ring holds one finished request, numbered `seq`. */
const ring = (seq: number): CompletionSink => ({
  head: seq, append: () => { throw new Error('read-only'); },
  since: (since, verdict) => {
    const reset = since !== undefined && since > seq, item = { seq, finishedAt: NOW - 42_000, startedAt: null, model: 'fixture', basis: 'reported' as const,
      promptTokens: 100, cachedTokens: 60, outputTokens: 20, ttftMs: 500, decodeTps: 38.6, overlapped: true, host: {} };
    const label = verdict(seq);
    return { instance: '00000000', cursor: seq, reset, items: since === undefined || reset || seq > since ? [label ? { ...item, verdict: label } : item] : [] };
  },
});
const bionic = (seq: number): RuntimeReading => ({
  at: NOW - 300, status: { state: 'ready', reason: null, params: {} }, identity: {}, completions: [],
  capabilities: { 'server.completions': { scope: 'server', basis: 'reported' }, 'server.requests': { scope: 'server', basis: 'observed' } },
  runtime: { phase: 'idle', request: null, server: { active: 0, queued: null }, memory: {}, residency: [], slots: [], catalog: [], engines: [] },
  meta: { connection: { id: 'bionic', label: 'Bionic', runtime: 'lmstudio', generation: 1, choices: [], detection: { basis: 'hint', confidence: 'medium' }, host: 'bionic' },
    port: 1234, slot: null, failures: 0, idleMs: 0, completions: ring(seq),
    compat: { message: null, connection: { selected: 'bionic', generation: null, diagnostic: 'ready', coverage: 'requests' }, modelID: null, contextWindow: null,
      statsState: 'unavailable', guardLevel: null, lastMissReason: null, traceEpoch: null } },
});

/** A service instance whose last finished request has `seq`; the panel reaches it the way the host does, with a string body. */
const service = async (instance: string, seq: number): Promise<SnapshotClient> => {
  const server = createScopeServer('test-token', { read: async () => bionic(seq), host: async () => host, completionHead: () => seq },
    { version: '2.0.0-test', instance, now: () => NOW });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return new SnapshotClient({ serviceRequest: async ({ path, query }) => {
    const response = await fetch(`${url}${path}?${new URLSearchParams(query as Record<string, string>)}`, { headers: { Authorization: 'Bearer test-token' } });
    return { status: response.status, body: await response.text() } as never;
  } }, () => NOW);
};

test('the last request stays through cursor polls and survives a service restart the panel outlived', async () => {
  const state = new ScopeState(NOW), poll = async (client: SnapshotClient) =>
    state.accept(await client.read({ frame: 'c0ffee42', surface: 'panel', since: state.since }));
  const first = await service('5c1e0a7b', 5);
  await poll(first);
  expect([state.since, state.lastRequest?.seq, state.lastRequest?.decodeTps]).toEqual([5, 5, 38.6]);
  await poll(first);
  expect([state.since, state.lastRequest?.seq]).toEqual([5, 5]);
  // A restarted service numbers from 1 again; the panel's cursor 5 is not its own, so it resyncs from the whole ring.
  const restarted = await service('0a1b2c3d', 1);
  await poll(restarted);
  expect([state.since, state.lastRequest?.seq, state.lastRequest?.model]).toEqual([1, 1, 'fixture']);
  await poll(restarted);
  expect(state.lastRequest?.seq).toBe(1);
});
