import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ChatMeasurement } from '../src/contract/chat.ts';
import type { SnapshotV2 } from '../src/contract/snapshot.ts';
import { ChatTelemetry, type ChatTarget } from './chat-telemetry.ts';
import type { RuntimeConnectionConfig } from './config.ts';
import type { DescriptorV2 } from './core/adapter-v2.ts';
import { RuntimeClient } from './runtime-client.ts';
import { createScopeServer } from './server.ts';

test('fresh chat followers retain speed across five-second expiry boundaries without duplicate collections or hidden work', async () => {
  const start = 1_790_690_700_000;
  let now = start, runtimeRequests = 0;
  const home = await realpath(await mkdtemp(join(tmpdir(), 'scope-chat-cadence-')));
  const directory = join(home, '.cache', 'mlx-scope', 'chat-telemetry');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const telemetry = new ChatTelemetry(home, () => now);
  const connection: RuntimeConnectionConfig = { id: 'fixture-local', label: 'Fixture local', runtime: 'lmstudio',
    config: { baseURL: new URL('http://127.0.0.1:1234/'), apiKey: null, preferredModel: null, issue: 'missing_credential',
      source: 'opencode', configStatus: 'present', authStatus: 'present', error: null } };
  const descriptor: DescriptorV2 = { id: 'lmstudio', hints: () => false, detect: [], cadence: () => 5_000,
    capabilities: [], identityEveryMs: 60_000, create: context => ({ identity: async () => true, dispose() {}, read: async () => {
      await context.get('/api/v1/models');
      return { at: context.now(), status: { state: 'ready', reason: null, params: {} }, capabilities: {}, identity: {}, completions: [],
        runtime: { phase: 'idle', request: null, server: { active: null, queued: null }, memory: {}, residency: [], slots: [], catalog: [], engines: [] } };
    } }) };
  const client = new RuntimeClient({ now: () => now, descriptors: [descriptor],
    readConfig: async () => ({ connections: [connection], issue: 'none', error: null }),
    fetchImpl: async () => { runtimeRequests++; return new Response('{"models":[]}'); } });
  const targetA: ChatTarget = { sessionKey: 'a'.repeat(64), modelKey: 'b'.repeat(64), providerKey: 'c'.repeat(64), endpointKey: 'd'.repeat(64) };
  const targetB = { ...targetA, sessionKey: 'e'.repeat(64) };
  const targets = [targetA, targetB];
  const measurement = (phase: ChatMeasurement['phase'] = 'generating'): ChatMeasurement => ({ scope: 'chat', basis: 'estimated-characters',
    timingBasis: 'delivery-window', phase, ...phase === 'generating' || phase === 'reasoning' ? { tokensPerSecond: 42 } : {},
    observedAtMs: now, expiresAtMs: now + 5_000, observation: { startedAtMs: now - 3_000, endedAtMs: now }, freshness: 'live' });
  const writer = '00000000-2222-4333-8444-555555555555';
  const publish = async (phase: ChatMeasurement['phase'] = 'generating') => writeFile(join(directory, `${writer}.json`), JSON.stringify({
    schemaVersion: 1, writerID: writer, companionVersion: '3.0.0', protocol: 'opencode-2.0.25', runtimeVersion: '2.0.25',
    updatedAtMs: now, expiresAtMs: now + 15_000, entries: targets.map(target => ({ ...target, measurement: measurement(phase) })),
  }), { mode: 0o600 });
  const server = createScopeServer('test-token', {
    read: (selection, request) => client.read(selection, request),
    chat: async query => {
      if (!query.frame || query.surface === 'background') return null;
      const target = targets.find(value => value.sessionKey === query.chat && value.modelKey === query.chatModel);
      return telemetry.observe(query.frame, target ?? null);
    },
  }, { instance: '01234567', now: () => now, monotonic: () => now - start });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const poll = async (surface: 'page' | 'panel' | 'status', frame: string, target: ChatTarget): Promise<SnapshotV2> => {
      const response = await fetch(`${origin}/v2/snapshot?surface=${surface}&frame=${frame}&provider=fixture-local&chat=${target.sessionKey}&chatModel=${target.modelKey}`,
        { headers: { Authorization: 'Bearer test-token' } });
      expect(response.status).toBe(200);
      return response.json();
    };
    // The full page watches a different concurrent chat; both followers still refresh their own matched observation.
    for (let elapsed = 0; elapsed <= 12_000; elapsed += 500) {
      now = start + elapsed;
      const phase = elapsed < 4_000 ? 'generating' : elapsed < 7_000 ? 'reasoning' : elapsed < 8_000 ? 'tool'
        : elapsed < 9_000 ? 'waiting' : 'generating';
      await publish(phase);
      const page = await poll('page', '00000001', targetB);
      const panel = await poll('panel', '00000002', targetA);
      expect(page.lease.leader).toBe(true);
      expect(panel.lease.leader).toBe(false);
      expect(panel.nextPollMs).toBe(500);
      expect(panel.chat).toEqual(measurement(phase));
      if (elapsed % 1_000 === 0) {
        const status = await poll('status', '00000003', targetA);
        expect(status.lease.leader).toBe(false);
        expect(status.nextPollMs).toBe(1_000);
        expect(status.chat).toEqual(measurement(phase));
      }
    }
    // Faster presentation reads reuse the same five-second runtime collection: 63 polls, only three collections.
    expect(runtimeRequests).toBe(3);
    const demandPath = join(directory, 'demand.json');
    const demand = await readFile(demandPath, 'utf8');
    expect(JSON.parse(demand).watched).toHaveLength(2);
    // Hidden views make no calls or renewals; time alone neither samples nor rewrites demand.
    now += 16_000;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(runtimeRequests).toBe(3);
    expect(await readFile(demandPath, 'utf8')).toBe(demand);
    const resumed = await poll('page', '00000001', targetB);
    expect(resumed.chat).toBeUndefined();
    expect(JSON.parse(await readFile(demandPath, 'utf8')).watched).toEqual([targetB]);
    // A real cancellation clears the speed immediately and restores the follower's normal yield.
    await publish('cancelled');
    const cancelled = await poll('status', '00000003', targetA);
    expect(cancelled.chat).toEqual(measurement('cancelled'));
    expect(cancelled.chat?.tokensPerSecond).toBeUndefined();
    expect(cancelled.nextPollMs).toBe(10_000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    client.dispose(); await telemetry.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
