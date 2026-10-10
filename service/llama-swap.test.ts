import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeConnectionConfig, RuntimeConnections } from './config.ts';
import type { RuntimeReply } from './core/adapter-v2.ts';
import { swapState } from './core/llama-swap.ts';
import { RuntimeClient } from './runtime-client.ts';

const reply = (body: unknown, status = 200, routeMissing = false): RuntimeReply => ({ status, body: body as RuntimeReply['body'], routeMissing });
const row = (model: string, state: string, proxy = 'http://127.0.0.1:8000') => ({ model, state, proxy, cmd: '/opt/server --port 8000', ttl: 0, name: model });

test('llama-swap is recognized only by its /running list, and only a ready loopback model server is followed', () => {
  for (const notSwap of [reply(null, 404), reply({ running: [] }, 200, true), reply({ models: [] }), reply({ running: 'x' }),
    reply({ running: [{ model: 'm' }] }), reply([row('m', 'ready')]), reply({ running: Array(17).fill(row('m', 'ready')) })]) expect(swapState(notSwap, null)).toBeNull();
  expect(swapState(reply({ running: [row('a', 'ready', 'http://localhost:8000/v1')] }), null))
    .toEqual({ kind: 'ready', backend: { model: 'a', origin: new URL('http://127.0.0.1:8000') } });
  expect(swapState(reply({ running: [row('a', 'starting')] }), null)).toEqual({ kind: 'loading' });
  expect(swapState(reply({ running: [row('a', 'stopping')] }), null)).toEqual({ kind: 'loading' });
  expect(swapState(reply({ running: [] }), null)).toEqual({ kind: 'idle' });
  expect(swapState(reply({ running: [row('a', 'stopped')] }), null)).toEqual({ kind: 'idle' });
  // A remote or credentialed backend is never read, and Scope never guesses between several ready servers.
  for (const proxy of ['https://models.example.com:8000', 'http://192.0.2.10:8000', 'http://user:secret@127.0.0.1:8000', 'http://127.0.0.1'])
    expect(swapState(reply({ running: [row('a', 'ready', proxy)] }), null)).toEqual({ kind: 'unsupported' });
  const two = reply({ running: [row('a', 'ready', 'http://127.0.0.1:8000'), row('b', 'ready', 'http://127.0.0.1:8001')] });
  expect(swapState(two, null)).toEqual({ kind: 'unsupported' });
  expect(swapState(two, 'b')).toEqual({ kind: 'ready', backend: { model: 'b', origin: new URL('http://127.0.0.1:8001') } });
});

const SPLASH = JSON.parse(readFileSync(join(import.meta.dir, '../tests/fixtures/splash/1.2.0/status.ready-idle.json'), 'utf8'));
const swapConnection: RuntimeConnectionConfig = { id: 'splash', label: 'Splash', runtime: 'splash', config: { baseURL: new URL('http://127.0.0.1:8080/'),
  apiKey: 'provider-key', preferredModel: 'qwen-a', issue: 'none', source: 'opencode', configStatus: 'present', authStatus: 'present', error: null } };
const configuration = (): RuntimeConnections => ({ connections: [swapConnection], issue: 'none', error: null });
function swapHost() {
  let running: unknown[] = [row('qwen-a', 'ready')];
  const calls: Array<{ origin: string; path: string; method: string; key: boolean }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input)), headers = new Headers(init?.headers);
    calls.push({ origin: url.origin, path: url.pathname, method: init?.method ?? 'GET', key: headers.has('authorization') });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.port === '8080') return url.pathname === '/running' ? json({ running }) : url.pathname === '/v1/models'
      ? json({ object: 'list', data: [{ id: 'qwen-a', object: 'model', owned_by: 'llama-swap' }] }) : new Response('404 page not found', { status: 404 });
    if (url.port === '8000' || url.port === '8001') return url.pathname === '/status' ? json(SPLASH) : new Response('not found', { status: 404 });
    throw new Error(`unexpected origin ${url.origin}`);
  };
  return { calls, fetchImpl, set: (rows: unknown[]) => { running = rows; } };
}

test('a Splash provider behind llama-swap is read from the ready model server, as Splash via llama-swap, without starting anything', async () => {
  let now = 1_790_690_700_000;
  const host = swapHost(), client = new RuntimeClient({ now: () => now, readConfig: async () => configuration(), fetchImpl: host.fetchImpl });
  try {
    const first = await client.read({ provider: 'splash' });
    expect(first.status.state).toBe('ready');
    expect(first.meta.connection).toMatchObject({ id: 'splash', runtime: 'splash', engine: 'splash', host: 'llama-swap' });
    expect(first.capabilities['server.requests']).toBeDefined();
    // Never an upstream passthrough, a load, or any write; the provider's key never reaches the model server.
    expect(host.calls.every(call => call.method === 'GET' && !call.path.startsWith('/upstream'))).toBe(true);
    expect(host.calls.filter(call => call.origin === 'http://127.0.0.1:8000').every(call => !call.key)).toBe(true);
    expect(host.calls.filter(call => call.origin === 'http://127.0.0.1:8080').map(call => call.path)).toContain('/running');
    const generation = first.meta.connection.generation;

    // A swapped model is a new generation; its readings never continue the previous model's.
    host.set([row('qwen-b', 'ready', 'http://127.0.0.1:8001')]); now += 5_000;
    const swapped = await client.read({ provider: 'splash' });
    expect(swapped.status.state).toBe('ready');
    expect(swapped.meta.connection.generation).toBeGreaterThan(generation);
    expect(host.calls.some(call => call.origin === 'http://127.0.0.1:8001' && call.path === '/status')).toBe(true);

    // Starting: say so. Nothing running: no model loaded. Scope never asks llama-swap to load one.
    host.set([row('qwen-a', 'starting')]); now += 5_000;
    expect(await client.read({ provider: 'splash' })).toMatchObject({ status: { state: 'degraded', reason: 'loading' }, runtime: { phase: 'loading' },
      meta: { connection: { host: 'llama-swap' } } });
    host.set([]); now += 5_000;
    expect(await client.read({ provider: 'splash' })).toMatchObject({ status: { state: 'ready', reason: null }, runtime: { phase: 'not-loaded' } });
    expect(host.calls.every(call => call.method === 'GET' && !call.path.startsWith('/upstream'))).toBe(true);
  } finally { client.dispose(); }
});
