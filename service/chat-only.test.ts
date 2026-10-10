import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatKey } from '../src/contract/chat-key.ts';
import { CHAT_SCOPE, type ChatMeasurement } from '../src/contract/chat.ts';
import type { SnapshotV2 } from '../src/contract/snapshot.ts';
import { version } from '../bridge/opencode/package.json';
import { createChatDestination, createChatSource } from './chat-source.ts';
import { ChatTelemetry, type ChatTarget } from './chat-telemetry.ts';
import { chatOnlyReading, createScopeServer, type Sources } from './server.ts';

const NOW = 1_790_690_700_000, INSTANCE = 'aabbccdd';
const servers: http.Server[] = [], homes: string[] = [], transports: ChatTelemetry[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve()); server.closeAllConnections();
  })));
  await Promise.all(transports.splice(0).map(transport => transport.dispose()));
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

const measurement = (at = NOW, rate = 42): ChatMeasurement => ({ scope: CHAT_SCOPE, basis: 'estimated-characters',
  timingBasis: 'delivery-window', phase: 'generating', tokensPerSecond: rate, freshness: 'live', observedAtMs: at,
  expiresAtMs: at + 5_000, observation: { startedAtMs: at - 2_500, endedAtMs: at } });
const query = (provider = 'cloud', session = 'remote-session', model = 'remote-model', extra = '') =>
  `/v2/snapshot?chatOnly=1&provider=${encodeURIComponent(provider)}&chat=${chatKey('session', session)}`
  + `&chatModel=${chatKey('model', model)}&frame=11111111&surface=status${extra}`;

async function launch(sources: Sources, clock = { now: NOW, monotonic: 1000 }) {
  const server = createScopeServer('test-token', sources, { instance: INSTANCE, now: () => clock.now, monotonic: () => clock.monotonic });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (path: string): Promise<SnapshotV2> => {
    const response = await fetch(base + path, { headers: { Authorization: 'Bearer test-token' } });
    expect(response.status).toBe(200);
    return response.json();
  };
}

function guarded(chat?: Sources['chat']) {
  const calls = { read: 0, host: 0, history: 0 };
  const sources: Sources = { chat,
    read: async () => { calls.read++; throw Error('Unexpected local runtime read'); },
    host: async () => { calls.host++; throw Error('Unexpected host diagnostic read'); },
    history: { get head(): number { calls.history++; throw Error('Unexpected engine history read'); },
      record: () => { calls.history++; throw Error('Unexpected engine history write'); },
      snapshot: () => { calls.history++; throw Error('Unexpected engine history snapshot'); } },
  };
  return { calls, sources };
}

async function transportFixture(clock = { now: NOW, monotonic: 1000 }) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'scope-remote-service-'))); homes.push(home);
  const directory = join(home, '.cache/mlx-scope/chat-telemetry'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const transport = new ChatTelemetry(home, () => clock.now); transports.push(transport);
  const id = randomUUID();
  const remote = { sessionKey: chatKey('session', 'remote-session'), modelKey: chatKey('model', 'remote-model'),
    providerKey: chatKey('provider', 'cloud'), endpointKey: chatKey('endpoint', 'https://fixture.invalid'), destination: 'remote' as const };
  const write = async (entries: unknown[], overrides: Record<string, unknown> = {}) => {
    await writeFile(join(directory, `${id}.json`), JSON.stringify({ schemaVersion: 1, writerID: id, companionVersion: version,
      protocol: 'opencode-2.0.25', runtimeVersion: '2.0.25', updatedAtMs: clock.now, expiresAtMs: clock.now + 15_000,
      entries, ...overrides }), { mode: 0o600 });
  };
  return { transport, directory, remote, write, clock };
}

test('remote-only snapshots bypass runtime, host and engine history even without a companion', async () => {
  const g = guarded(), request = await launch(g.sources);
  const value = await request(query('cloud', 'remote-session', 'remote-model', '&chatBusy=1&since=12&mark=started.1790690700000.deadbeef&attr=1.inferred.-'));
  expect(g.calls).toEqual({ read: 0, host: 0, history: 0 });
  expect(value).toMatchObject({ connection: { id: 'cloud', runtime: null, choices: [] }, status: { state: 'ready', reason: null },
    capabilities: {}, host: null, completions: { cursor: 0, reset: true, items: [] }, alerts: [], alertLog: [], marksHead: 0,
    runtime: { phase: 'unknown', request: null, server: { active: null, queued: null }, memory: {}, residency: [] }, nextPollMs: 1000 });
  expect(value.chat).toBeUndefined();
});

test('selected chats resolve remote from configuration before their first runtime or diagnostic read', async () => {
  const f = await transportFixture(); await f.write([{ ...f.remote, measurement: measurement() }]);
  const metadataProviders: string[] = [];
  const client = { companionTarget: async (provider: string) => { metadataProviders.push(provider); return null; } };
  const g = guarded(createChatSource(f.transport, client)); g.sources.chatDestination = createChatDestination(client);
  const request = await launch(g.sources, f.clock);
  const body = await request(query().replace('chatOnly=1&', ''));
  expect(body.chat?.tokensPerSecond).toBe(42); expect(body.connection.id).toBe('cloud');
  expect(metadataProviders).toEqual(['cloud']); expect(g.calls).toEqual({ read: 0, host: 0, history: 0 });
});

test('destination resolution uses configured locality and never provider-name guesses or whole-engine queries', async () => {
  const metadataProviders: string[] = [];
  const client = { companionTarget: async (provider: string) => {
    metadataProviders.push(provider); return provider === 'anthropic' ? { providerKey: 'c'.repeat(64), endpointKey: 'd'.repeat(64) } : null; } };
  let reads = 0;
  const request = await launch({ read: async () => { reads++; return chatOnlyReading('anthropic', NOW); },
    chatDestination: createChatDestination(client) });
  await request(query('anthropic').replace('chatOnly=1&', ''));
  expect(reads).toBe(1); expect(metadataProviders).toEqual(['anthropic']);
  await request('/v2/snapshot?provider=cloud&surface=page');
  expect(reads).toBe(2); expect(metadataProviders).toEqual(['anthropic']);
  await request(query('my-local-looking-name').replace('chatOnly=1&', ''));
  expect(reads).toBe(2); expect(metadataProviders).toEqual(['anthropic', 'my-local-looking-name']);
});

test('unreadable selected-chat metadata safely withholds data without probing any fallback engine', async () => {
  const g = guarded(); g.sources.chatDestination = async () => { throw Error('PRIVATE configuration'); };
  const request = await launch(g.sources);
  const body = await request(query().replace('chatOnly=1&', ''));
  expect(body.chat).toBeUndefined(); expect(body.connection.runtime).toBeNull();
  expect(JSON.stringify(body)).not.toContain('PRIVATE'); expect(g.calls).toEqual({ read: 0, host: 0, history: 0 });
});

test('remote demand hashes only the exact selected provider/session/model and never consults local config', async () => {
  const f = await transportFixture(); let localTargets = 0;
  await f.write([{ ...f.remote, measurement: measurement() }]);
  const source = createChatSource(f.transport, { companionTarget: async () => { localTargets++; throw Error('local config'); } });
  const g = guarded(source), request = await launch(g.sources, f.clock);
  expect((await request(query())).chat).toEqual(measurement());
  const demand = JSON.parse(await readFile(join(f.directory, 'demand.json'), 'utf8'));
  expect(demand.watched).toEqual([{ sessionKey: f.remote.sessionKey, modelKey: f.remote.modelKey,
    providerKey: f.remote.providerKey, destination: 'remote' }]);
  expect(JSON.stringify(demand)).not.toMatch(/remote-session|remote-model|fixture.invalid/);
  for (const path of [query('other-cloud'), query('cloud', 'other-session'), query('cloud', 'remote-session', 'other-model')])
    expect((await request(path)).chat).toBeUndefined();
  expect(localTargets).toBe(0); expect(g.calls).toEqual({ read: 0, host: 0, history: 0 });
});

test('cloud views present every observed delivery phase under the chat scope and republish remote demand', async () => {
  const f = await transportFixture(); let localTargets = 0;
  const source = createChatSource(f.transport, { companionTarget: async () => { localTargets++; throw Error('local config'); } });
  const g = guarded(source), request = await launch(g.sources, f.clock);
  for (const phase of ['generating', 'reasoning', 'complete', 'cancelled'] as const) {
    const observed: ChatMeasurement = { ...measurement(), phase, ...phase === 'complete'
      ? { basis: 'reported-output', timingBasis: 'completed-step', freshness: 'last', expiresAtMs: f.clock.now + 15_000 }
      : phase === 'cancelled' ? { tokensPerSecond: undefined } : {} };
    await f.write([{ ...f.remote, measurement: observed }]);
    const value = await request(query('cloud', 'remote-session', 'remote-model', '&chatBusy=1'));
    // Delivery observed through OpenCode, never an engine reading; identity and origin never reach the wire.
    expect(value.chat).toEqual(observed); expect(value.chat?.scope).toBe(CHAT_SCOPE);
    expect(value.nextPollMs).toBe(1000); expect(JSON.stringify(value.chat)).not.toMatch(/session|model|endpoint|invalidsi/);
    const demand = JSON.parse(await readFile(join(f.directory, 'demand.json'), 'utf8'));
    expect(demand.watched).toEqual([{ sessionKey: f.remote.sessionKey, modelKey: f.remote.modelKey,
      providerKey: f.remote.providerKey, destination: 'remote' }]);
  }
  expect(localTargets).toBe(0); expect(g.calls).toEqual({ read: 0, host: 0, history: 0 });
});

test('remote freshness, cancellation, missing writers and unqualified companions always clear live speed', async () => {
  const f = await transportFixture(), g = guarded(createChatSource(f.transport, { companionTarget: async () => null }));
  const request = await launch(g.sources, f.clock);
  await f.write([{ ...f.remote, measurement: measurement() }]); expect((await request(query())).chat?.tokensPerSecond).toBe(42);
  f.clock.now += 5_000; f.clock.monotonic += 5_000;
  expect((await request(query())).chat).toBeUndefined();
  const cancelled: ChatMeasurement = { ...measurement(f.clock.now), phase: 'cancelled', tokensPerSecond: undefined };
  await f.write([{ ...f.remote, measurement: cancelled }]);
  expect((await request(query())).chat).toEqual(cancelled);
  // Unsupported companion generations disable estimates without breaking the surrounding snapshot.
  for (const overrides of [{ companionVersion: '2.1.6' }, { protocol: 'opencode-future' }, { runtimeVersion: '2.0.26' }]) {
    await f.write([{ ...f.remote, measurement: measurement(f.clock.now) }], overrides);
    expect((await request(query())).chat).toBeUndefined();
  }
  await f.write([]); expect((await request(query())).chat).toBeUndefined();
  expect(g.calls).toEqual({ read: 0, host: 0, history: 0 });
});

test('a visible remote chat retains active cadence while another page owns the presentation lease', async () => {
  let observed: ChatMeasurement | null = null;
  const g = guarded(async () => observed), request = await launch(g.sources);
  await request(query('other-cloud', 'other-session', 'other-model').replace('11111111', '22222222').replace('surface=status', 'surface=page'));
  let value = await request(query('cloud', 'remote-session', 'remote-model', '&chatBusy=1'));
  expect(value.lease.leader).toBe(false); expect(value.nextPollMs).toBe(1000);
  observed = measurement(); value = await request(query()); expect(value.nextPollMs).toBe(1000);
  expect((await request(query().replace('surface=status', 'surface=panel'))).nextPollMs).toBe(500);
  expect(g.calls).toEqual({ read: 0, host: 0, history: 0 });
});

test('a cloud view presents a delivery observation from any source without collecting runtime, host or engine data', async () => {
  const g = guarded(async () => measurement()), request = await launch(g.sources);
  for (const surface of ['status', 'panel', 'page']) {
    const value = await request(query().replace('surface=status', `surface=${surface}`));
    expect(value.chat).toEqual(measurement()); expect(value.chat?.scope).toBe(CHAT_SCOPE);
    expect(value.connection.runtime).toBeNull(); expect(value.host).toBeNull(); expect(value.capabilities).toEqual({});
  }
  expect(g.calls).toEqual({ read: 0, host: 0, history: 0 });
});

test('simultaneous local and remote chats share demand without mixing engine readings or history', async () => {
  const f = await transportFixture(), local: ChatTarget = { sessionKey: chatKey('session', 'local-session'),
    modelKey: chatKey('model', 'local-model'), providerKey: chatKey('provider', 'local'), endpointKey: chatKey('endpoint', 'http://127.0.0.1:8000') };
  await f.write([{ ...f.remote, measurement: measurement(NOW, 42) }, { ...local, measurement: measurement(NOW, 53) }]);
  let reads = 0, hosts = 0, histories = 0, targets = 0;
  const sources: Sources = {
    read: async () => { reads++; const empty = chatOnlyReading('local', NOW); return { ...empty,
      meta: { ...empty.meta, connection: { ...empty.meta.connection, runtime: 'omlx', choices: [{ id: 'local', label: 'Local', runtime: 'omlx' }] } } }; },
    host: async () => { hosts++; return null; },
    history: { head: 0, record: () => { histories++; }, snapshot: () => ({ completions: { instance: INSTANCE, cursor: 0, reset: false, items: [] }, alerts: [], alertLog: [] }) },
    chat: createChatSource(f.transport, { companionTarget: async provider => {
      targets++; expect(provider).toBe('local'); return { providerKey: local.providerKey, endpointKey: local.endpointKey }; } }),
  };
  const request = await launch(sources, f.clock);
  const localQuery = `/v2/snapshot?provider=local&frame=22222222&surface=page&chat=${local.sessionKey}&chatModel=${local.modelKey}`;
  const [localView, remoteView] = await Promise.all([request(localQuery), request(query())]);
  expect([localView.chat?.tokensPerSecond, remoteView.chat?.tokensPerSecond]).toEqual([53, 42]);
  expect([reads, hosts, histories, targets]).toEqual([1, 1, 1, 1]);
  expect(remoteView.connection.runtime).toBeNull(); expect(remoteView.host).toBeNull(); expect(remoteView.capabilities).toEqual({});
  const demand = JSON.parse(await readFile(join(f.directory, 'demand.json'), 'utf8'));
  expect(demand.watched).toHaveLength(2); expect(demand.watched).toContainEqual(local);
  expect(demand.watched).toContainEqual({ sessionKey: f.remote.sessionKey, modelKey: f.remote.modelKey,
    providerKey: f.remote.providerKey, destination: 'remote' });
});

test('remote telemetry failures and background frames do not trigger fallback collectors', async () => {
  const failing = guarded(async () => { throw Error('PRIVATE'); });
  const request = await launch(failing.sources); expect((await request(query())).chat).toBeUndefined();
  expect(failing.calls).toEqual({ read: 0, host: 0, history: 0 });
  let observations = 0, targets = 0;
  const source = createChatSource({ observe: async () => { observations++; return measurement(); } },
    { companionTarget: async () => { targets++; return null; } });
  const background = guarded(source), backgroundRequest = await launch(background.sources);
  expect((await backgroundRequest(query().replace('surface=status', 'surface=background'))).chat).toBeUndefined();
  expect([observations, targets]).toEqual([0, 0]); expect(background.calls).toEqual({ read: 0, host: 0, history: 0 });
});
