// The host part of /v2/snapshot end to end: createScopeServer with a HostSampler source on fixture probes. The query's
// tier reaches the sampler, only an answering oMLX enables lsof → footprint, and the body stays honest with no PID in it.
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { classAKeys } from '../../src/contract/guards.ts';
import { honestyViolations, parseSnapshotV2, type Phase, type SnapshotV2 } from '../../src/contract/snapshot.ts';
import { EXEC_PATHS, type Argv } from '../lib/argv.ts';
import type { RuntimeReading } from '../runtime-client.ts';
import { createScopeServer, hostContextOf, type Sources } from '../server.ts';
import { HostSampler, type HostContext } from './sampler.ts';

const NOW = 1_790_690_700_000, GiB = 2 ** 30;
const fixture = (name: string): string => readFileSync(join(import.meta.dir, '../../tests/fixtures/host/macos-27', name), 'utf8');
const OUTPUT: Record<string, string> = {
  [EXEC_PATHS.vmStat]: fixture('vm_stat.pressure.txt'), [EXEC_PATHS.sysctl]: fixture('sysctl.pressure-4.txt'),
  [EXEC_PATHS.ioreg]: fixture('ioreg.idle.txt'), [EXEC_PATHS.notifyutil]: fixture('notifyutil.level-3.txt'),
  [EXEC_PATHS.lsof]: fixture('lsof.listening.txt'), [EXEC_PATHS.footprint]: fixture('footprint.no-categories-bytes.txt'),
};
const reading = (runtime: 'omlx' | 'splash' | null, phase: Phase = 'idle', port: number | null = 8001): RuntimeReading => ({
  at: NOW - 300, status: runtime === null ? { state: 'failing', reason: 'runtime_unreachable', params: {} } : { state: 'ready', reason: null, params: {} },
  capabilities: {}, identity: {}, completions: [],
  runtime: { phase: runtime === null ? 'unknown' : phase, request: null, server: { active: null, queued: null }, memory: {}, residency: [], slots: [], catalog: [], engines: [] },
  meta: { connection: { id: 'auto', label: 'Automatic', runtime, generation: 4, choices: [], detection: { basis: 'hint', confidence: 'medium' } },
    port, slot: null, failures: 0, idleMs: 0, cadenceMs: 450 },
});

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
});
const launch = async (read: () => RuntimeReading) => {
  const calls: Argv[] = [], contexts: HostContext[] = [];
  const sampler = new HostSampler({ exec: async argv => { calls.push(argv); return OUTPUT[argv.file] ?? null; }, now: () => NOW,
    monotonic: () => 1_000, platform: 'darwin', macmon: null, os: { cpus: () => [], freemem: () => 16 * GiB, totalmem: () => 48 * GiB } });
  const sources: Sources = { read: async () => read(), host: async context => { contexts.push(context); return sampler.sample(context); } };
  const server = createScopeServer('test-token', sources, { version: '2.0.0-test', instance: '5c1e0a7b', now: () => NOW });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const get = async (path: string): Promise<SnapshotV2> => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { headers: { Authorization: 'Bearer test-token' } });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(/\b424[23]\b/);
    return JSON.parse(text) as SnapshotV2;
  };
  return { get, calls, contexts };
};

test('a full-tier snapshot carries every host part with its capability and basis', async () => {
  const { get, calls, contexts } = await launch(() => reading('omlx', 'decode'));
  const body = await get('/v2/snapshot?surface=panel');
  expect(contexts).toEqual([{ tier: 'full', active: true, generation: 4, omlxPort: 8001 }]);
  expect(parseSnapshotV2(body)).toEqual(body);
  expect(honestyViolations(body)).toEqual([]);
  expect(classAKeys(body)).toEqual([]);
  expect(body.host).toEqual({
    sampledAt: NOW, platform: 'macOS', memTotalBytes: 48 * GiB, memUsedBytes: 32 * GiB,
    mac: { sampledAt: NOW, wiredBytes: 36_239_835_136, compressedBytes: 8_162_689_024, pressureLevel: 4, wiredLimitBytes: 42_949_672_960,
      swapUsedBytes: 10_288_103_424, swapTotalBytes: 10_737_418_240 },
    gpu: { sampledAt: NOW, busyFraction: 0.04, allocBytes: 28 * GiB, inUseBytes: GiB },
    thermal: { sampledAt: NOW, level: 3 },
    runtimeProcess: { sampledAt: NOW, runtime: 'omlx', port: 8001, footprintBytes: 20_008_894_464 },
  });
  const host = Object.fromEntries(Object.entries(body.capabilities).filter(([key]) => key.startsWith('host.')));
  expect(host).toEqual(Object.fromEntries(['host.memory', 'host.swap', 'host.pressure', 'host.wiredLimit', 'host.gpuBusy', 'host.gpuMemory',
    'host.thermal', 'host.footprint'].map(key => [key, { scope: 'host', basis: 'reported' }])));
  expect(calls.map(argv => argv.file.split('/').at(-1))).toEqual(['vm_stat', 'sysctl', 'notifyutil', 'ioreg', 'lsof', 'footprint']);
});

test('the status surface defaults to warning-only glance probes; full explicitly enables GPU and process diagnostics', async () => {
  const { get, calls, contexts } = await launch(() => reading('omlx'));
  const body = await get('/v2/snapshot?surface=status');
  expect(contexts[0]!.tier).toBe('glance');
  expect(body.host!.runtimeProcess).toBeUndefined();
  expect(body.capabilities['host.footprint']).toBeUndefined();
  expect(body.host!.gpu).toBeUndefined();
  expect(body.capabilities['host.gpuBusy']).toBeUndefined();
  expect(body.capabilities['host.gpuMemory']).toBeUndefined();
  expect(calls.map(argv => argv.file.split('/').at(-1))).toEqual(['vm_stat', 'sysctl', 'notifyutil']);
  const full = await get('/v2/snapshot?surface=status&tier=full');
  expect(full.host!.runtimeProcess).toBeDefined();
  expect(full.host!.gpu).toBeDefined();
});

test('only an answering oMLX on a loopback port gets the footprint probe', () => {
  expect(hostContextOf('full', reading('omlx'))).toEqual({ tier: 'full', active: false, generation: 4, omlxPort: 8001 });
  expect(hostContextOf('full', reading('omlx', 'prefill')).active).toBe(true);
  expect(hostContextOf('full', reading('splash')).omlxPort).toBeNull();
  expect(hostContextOf('full', reading(null)).omlxPort).toBeNull();
  expect(hostContextOf('full', reading('omlx', 'idle', null)).omlxPort).toBeNull();
  expect(hostContextOf('glance', reading('omlx', 'idle', null))).toEqual({ tier: 'glance', active: false, generation: 4, omlxPort: null });
});

test('a failing host source leaves the host out and the runtime reading intact', async () => {
  const sources: Sources = { read: async () => reading('omlx'), host: async () => { throw new Error('private detail'); } };
  const server = createScopeServer('test-token', sources, { instance: '5c1e0a7b', now: () => NOW });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/snapshot`, { headers: { Authorization: 'Bearer test-token' } });
  const body = await response.json() as SnapshotV2;
  expect(response.status).toBe(200);
  expect(body.host).toBeNull();
  expect(Object.keys(body.capabilities).filter(key => key.startsWith('host.'))).toEqual([]);
  expect(body.status.state).toBe('ready');
  expect(JSON.stringify(body)).not.toContain('private detail');
});
