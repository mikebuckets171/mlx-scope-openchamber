import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { CapabilityKey } from '../../src/contract/capabilities.ts';
import { hostCapabilities, parseHostV2, type HostV2 } from '../../src/contract/host.ts';
import { requiredCapabilities } from '../../src/contract/snapshot.ts';
import { fullSnapshot } from '../../src/contract/testing/full.ts';
import { allowed, EXEC_PATHS, type Argv, type StreamChild } from '../lib/argv.ts';
import { cpuFraction, HostSampler, PROBE_CADENCE, probeCadence, SPAWN_BUDGET_PER_MIN, spawnBudget, type HostContext } from './sampler.ts';

const HOME = '/Users/someone', EPOCH = 1_790_690_700_000, GiB = 2 ** 30;
const fixture = (name: string): string => readFileSync(join(import.meta.dir, '../../tests/fixtures/host/macos-27', name), 'utf8');
const OUTPUT: Record<string, string> = {
  [EXEC_PATHS.vmStat]: fixture('vm_stat.normal.txt'), [EXEC_PATHS.sysctl]: fixture('sysctl.pressure-2.txt'),
  [EXEC_PATHS.ioreg]: fixture('ioreg.busy.txt'), [EXEC_PATHS.notifyutil]: fixture('notifyutil.level-2.txt'),
  [EXEC_PATHS.lsof]: fixture('lsof.listening.txt'), [EXEC_PATHS.footprint]: fixture('footprint.no-categories-bytes.txt'),
};
/** A quarter of every core busy between any two reads. */
const cores = (read: number) => Array.from({ length: 4 }, () => ({ model: 'Apple M-series · fixture', speed: 0,
  times: { user: 250 * read, nice: 0, sys: 0, idle: 750 * read, irq: 0 } }));

/** A sampler on a fake clock whose exec answers from the fixture corpus and records every argv with its time. */
const rig = (options: { platform?: string; output?: Record<string, string | null>; macmon?: string | null } = {}) => {
  const clock = { t: 0 }, calls: Array<{ at: number; argv: Argv }> = [], output = { ...OUTPUT, ...options.output };
  let ticks = 0;
  const sampler = new HostSampler({
    exec: async argv => { calls.push({ at: clock.t, argv }); return output[argv.file] ?? null; },
    now: () => EPOCH + clock.t, monotonic: () => clock.t, platform: options.platform ?? 'darwin', home: HOME,
    macmon: options.macmon ?? null, os: { cpus: () => cores(++ticks), freemem: () => 12 * GiB, totalmem: () => 48 * GiB },
  });
  return { sampler, clock, calls, output };
};
const context = (overrides: Partial<HostContext> = {}): HostContext => ({ tier: 'full', active: false, generation: 1, omlxPort: 8001, ...overrides });
/** Polls at `everyMs` for `forMs`, like a visible frame. */
const poll = async (r: ReturnType<typeof rig>, everyMs: number, forMs: number, at: HostContext | ((t: number) => HostContext)) => {
  let last: HostV2 | null = null;
  for (const end = r.clock.t + forMs; r.clock.t < end; r.clock.t += everyMs) last = await r.sampler.sample(typeof at === 'function' ? at(r.clock.t) : at);
  return last;
};
const spawnsIn = (calls: Array<{ at: number }>, from = 0) => calls.filter(call => call.at >= from).length;
/** The most children started in any 60 s window. */
const peakPerMinute = (calls: Array<{ at: number }>): number =>
  Math.max(0, ...calls.map(({ at }) => calls.filter(call => call.at >= at && call.at < at + 60_000).length));
const byFile = (calls: Array<{ argv: Argv }>) => calls.reduce<Record<string, number>>((all, { argv }) =>
  ({ ...all, [argv.file.split('/').at(-1)!]: (all[argv.file.split('/').at(-1)!] ?? 0) + 1 }), {});

test('the cadence table and budgets are the §4.4 / contract §8 numbers', () => {
  expect(PROBE_CADENCE).toEqual({ memory: [10_000, 10_000, 10_000], gpu: [15_000, 5_000, null], thermal: [60_000, 60_000, 60_000],
    listener: [120_000, 120_000, null], footprint: [30_000, 10_000, null] });
  expect(SPAWN_BUDGET_PER_MIN).toEqual({ idle: 24, active: 36, glance: 18 });
  expect(probeCadence('gpu', { tier: 'full', active: true })).toBe(5_000);
  expect(probeCadence('gpu', { tier: 'glance', active: true })).toBeNull();
  expect(probeCadence('footprint', { tier: 'glance', active: true })).toBeNull();
  expect([spawnBudget({ tier: 'glance', active: true }), spawnBudget({ tier: 'full', active: false }), spawnBudget({ tier: 'full', active: true })])
    .toEqual([18, 24, 36]);
});

test('a full read fills every macOS part from the probes, with no PID anywhere', async () => {
  const r = rig();
  const host = (await r.sampler.sample(context()))!;
  expect(host).toEqual({
    sampledAt: EPOCH, platform: 'macOS', cpuModel: 'Apple M-series · fixture', logicalCores: 4, memTotalBytes: 48 * GiB, memUsedBytes: 36 * GiB,
    mac: { sampledAt: EPOCH, wiredBytes: 20_561_526_784, compressedBytes: 5_120_983_040, pressureLevel: 2, wiredLimitBytes: 40_960 * 2 ** 20,
      swapUsedBytes: 3_163_815_936, swapTotalBytes: 4_294_967_296 },
    gpu: { sampledAt: EPOCH, busyFraction: 0.87, allocBytes: 31 * GiB, inUseBytes: 18 * GiB },
    thermal: { sampledAt: EPOCH, level: 2 },
    runtimeProcess: { sampledAt: EPOCH, runtime: 'omlx', port: 8001, footprintBytes: 20_008_894_464 },
  });
  expect(parseHostV2(host)).toEqual(host);
  expect(JSON.stringify(host)).not.toMatch(/\b424[23]\b/);
  expect(r.calls.map(({ argv }) => argv.file)).toEqual(['/usr/bin/vm_stat', '/usr/sbin/sysctl', '/usr/bin/notifyutil', '/usr/sbin/ioreg',
    '/usr/sbin/lsof', '/usr/bin/footprint']);
  for (const { argv } of r.calls) expect(allowed(argv, HOME), JSON.stringify(argv)).toBe(true);
  // The CPU share needs a second sample 2 s later.
  r.clock.t += 2_000;
  expect((await r.sampler.sample(context()))!.cpuFraction).toBe(0.25);
});

test('capabilities are exactly the parts present, macmon power is the only estimate, and they match the honesty map', async () => {
  const host = (await rig().sampler.sample(context()))!;
  const keys = hostCapabilities(host);
  expect(keys).toEqual(['host.memory', 'host.swap', 'host.pressure', 'host.wiredLimit', 'host.gpuBusy', 'host.gpuMemory', 'host.thermal',
    'host.footprint'].map(key => ({ key: key as CapabilityKey, basis: 'reported' })));
  expect(keys.map(({ key }) => key).sort()).toEqual(requiredCapabilities({ host }).sort());
  const power = { sampledAt: EPOCH, field: 'all_power' as const, chipW: 20, coverageFraction: 1 };
  expect(hostCapabilities({ sampledAt: EPOCH, power, cpuFraction: 0.5 })).toEqual([{ key: 'host.cpu', basis: 'reported' }, { key: 'host.power', basis: 'estimate' }]);
  // Every host field in the honesty map, and no more: a full host needs exactly the ten host keys.
  const full = parseHostV2(fullSnapshot().host)!;
  expect(hostCapabilities(full).map(({ key }) => key).sort()).toEqual(requiredCapabilities({ host: full }).sort());
  expect(hostCapabilities(full)).toHaveLength(10);
  expect(hostCapabilities(null)).toEqual([]);
  expect(hostCapabilities({ sampledAt: EPOCH })).toEqual([]);
});

test('glance tier collects memory and thermal warnings, never GPU diagnostics, lsof, footprint or macmon', async () => {
  const r = rig();
  const last = await poll(r, 1_000, 600_000, context({ tier: 'glance', active: true }));
  expect(Object.keys(byFile(r.calls)).sort()).toEqual(['notifyutil', 'sysctl', 'vm_stat']);
  expect(peakPerMinute(r.calls)).toBeLessThanOrEqual(18);
  expect(byFile(r.calls)).toEqual({ vm_stat: 60, sysctl: 60, notifyutil: 10 });
  expect(last!.runtimeProcess).toBeUndefined();
  expect(last!.gpu).toBeUndefined();
  expect(last!.mac!.pressureLevel).toBe(2);
  expect(last!.thermal!.level).toBe(2);
});

test('glance may reuse full-view GPU data but never refreshes it; returning to full resumes collection', async () => {
  const r = rig();
  await r.sampler.sample(context());
  r.clock.t = 15_000;
  expect((await r.sampler.sample(context({ tier: 'glance' })))!.gpu?.sampledAt).toBe(EPOCH);
  r.clock.t = 46_000;
  expect((await r.sampler.sample(context({ tier: 'glance' })))!.gpu).toBeUndefined();
  expect(byFile(r.calls).ioreg).toBe(1);
  expect((await r.sampler.sample(context()))!.gpu?.sampledAt).toBe(EPOCH + 46_000);
  expect(byFile(r.calls).ioreg).toBe(2);
});

test('full tier idle (2 s) stays ≤ 24 spawns a minute; active (500 ms) ≤ 36, with GPU at 5 s and footprint at 10 s', async () => {
  const idle = rig();
  await poll(idle, 2_000, 600_000, context());
  expect(peakPerMinute(idle.calls)).toBeLessThanOrEqual(24);
  // 15 s on 2 s polls is a read every 16 s.
  expect(byFile(idle.calls)).toEqual({ vm_stat: 60, sysctl: 60, ioreg: 38, notifyutil: 10, lsof: 5, footprint: 20 });
  const active = rig();
  await poll(active, 500, 600_000, context({ active: true }));
  expect(peakPerMinute(active.calls)).toBeLessThanOrEqual(36);
  expect(byFile(active.calls)).toEqual({ vm_stat: 60, sysctl: 60, ioreg: 120, notifyutil: 10, lsof: 5, footprint: 60 });
});

test('the budget holds over any minute, whatever mix of tiers and frames reads', async () => {
  const r = rig();
  // A panel at 500 ms and a status section at 1 s on the same sampler, then the status section alone.
  await poll(r, 500, 300_000, t => t % 1_000 === 0 ? context({ tier: 'glance', active: true }) : context({ active: true }));
  const mixed = r.calls.length;
  expect(peakPerMinute(r.calls)).toBeLessThanOrEqual(36);
  const switchedAt = r.clock.t;
  await poll(r, 1_000, 300_000, context({ tier: 'glance', active: true }));
  expect(peakPerMinute(r.calls.filter(call => call.at >= switchedAt))).toBeLessThanOrEqual(18);
  // Right after the switch, the last minute of full-tier spawns leaves no room: glance reuses the fresh parts.
  expect(spawnsIn(r.calls.slice(mixed).filter(call => call.at < switchedAt + 10_000))).toBe(0);
  const host = (await r.sampler.sample(context({ tier: 'glance', active: true })))!;
  expect(host.mac && host.thermal).toBeTruthy();
  expect(host.gpu).toBeUndefined();
});

test('concurrent reads share one flight per probe', async () => {
  const r = rig();
  const [a, b] = await Promise.all([r.sampler.sample(context()), r.sampler.sample(context({ tier: 'glance' }))]);
  expect(r.calls).toHaveLength(6);
  expect(a!.gpu).toEqual(b!.gpu);
});

test('a runtime that is not oMLX, or a non-loopback one, never runs lsof or footprint', async () => {
  const r = rig();
  const host = await poll(r, 2_000, 300_000, context({ omlxPort: null }));
  expect(byFile(r.calls).lsof).toBeUndefined();
  expect(byFile(r.calls).footprint).toBeUndefined();
  expect(host!.runtimeProcess).toBeUndefined();
});

test('lsof runs again on a new generation or port, and at once after the listener goes away', async () => {
  const r = rig();
  await r.sampler.sample(context());
  r.clock.t += 2_000;
  await r.sampler.sample(context({ generation: 2 }));
  expect(byFile(r.calls).lsof).toBe(2);
  r.clock.t += 2_000;
  const moved = await r.sampler.sample(context({ generation: 2, omlxPort: 8002 }));
  expect(byFile(r.calls).lsof).toBe(3);
  expect(moved!.runtimeProcess!.port).toBe(8002);
  // The process exited: footprint fails, the part goes at once, and the next read looks the listener up again.
  r.output[EXEC_PATHS.footprint] = null;
  r.clock.t += 30_000;
  expect((await r.sampler.sample(context({ generation: 2, omlxPort: 8002 })))!.runtimeProcess).toBeUndefined();
  r.output[EXEC_PATHS.lsof] = null;
  r.clock.t += 2_000;
  await r.sampler.sample(context({ generation: 2, omlxPort: 8002 }));
  expect(byFile(r.calls).lsof).toBe(4);
  // Nothing listens: the next lookup waits for the 120 s cadence.
  r.clock.t += 60_000;
  await r.sampler.sample(context({ generation: 2, omlxPort: 8002 }));
  expect(byFile(r.calls).lsof).toBe(4);
});

test('a frame on another connection neither reads nor resets the oMLX listener, and never sees its footprint', async () => {
  const r = rig();
  await r.sampler.sample(context());
  for (let read = 0; read < 10; read++) {
    r.clock.t += 1_000;
    expect((await r.sampler.sample(context({ omlxPort: null, generation: 9 })))!.runtimeProcess).toBeUndefined();
    r.clock.t += 1_000;
    expect((await r.sampler.sample(context()))!.runtimeProcess!.port).toBe(8001);
  }
  expect(byFile(r.calls)).toMatchObject({ lsof: 1, footprint: 1 });
});

test('two processes on the listening socket are ambiguous: no footprint', async () => {
  const r = rig({ output: { [EXEC_PATHS.lsof]: fixture('lsof.multiple.txt') } });
  const host = await poll(r, 2_000, 120_000, context());
  expect(byFile(r.calls).footprint).toBeUndefined();
  expect(host!.runtimeProcess).toBeUndefined();
});

test('the PID-reuse guard: another name or a shrinking lifetime peak drops the reading and looks the listener up again', async () => {
  const report = fixture('footprint.no-categories-bytes.txt');
  for (const reused of [report.replace('python3 [4242]', 'node [4242]'), report.replace('phys_footprint_peak: 21082685440', 'phys_footprint_peak: 20008894464')]) {
    const r = rig();
    expect((await r.sampler.sample(context()))!.runtimeProcess!.footprintBytes).toBe(20_008_894_464);
    r.output[EXEC_PATHS.footprint] = reused;
    r.clock.t += 30_000;
    expect((await r.sampler.sample(context()))!.runtimeProcess).toBeUndefined();
    expect(byFile(r.calls)).toMatchObject({ lsof: 1, footprint: 2 });
    r.clock.t += 2_000;
    // The new lookup finds a listener again; its first report becomes the new identity.
    expect((await r.sampler.sample(context()))!.runtimeProcess).toBeDefined();
    expect(byFile(r.calls)).toMatchObject({ lsof: 2, footprint: 3 });
  }
});

test('a failing probe keeps its last reading for three cadences, then it is a gap', async () => {
  const r = rig();
  await r.sampler.sample(context());
  r.output[EXEC_PATHS.notifyutil] = fixture('notifyutil.failed.txt');
  r.output[EXEC_PATHS.ioreg] = fixture('ioreg.truncated.txt');
  r.clock.t += 45_000;
  const kept = (await r.sampler.sample(context()))!;
  expect(kept.thermal).toEqual({ sampledAt: EPOCH, level: 2 });
  expect(kept.gpu!.sampledAt).toBe(EPOCH);
  r.clock.t += 1_000;
  const dropped = (await r.sampler.sample(context()))!;
  expect(dropped.gpu).toBeUndefined();
  expect(dropped.thermal).toBeDefined();
  r.clock.t += 180_000;
  expect((await r.sampler.sample(context()))!.thermal).toBeUndefined();
});

test('non-macOS hosts never execute a probe', async () => {
  const r = rig({ platform: 'linux' });
  const host = await poll(r, 500, 60_000, context({ active: true }));
  expect(r.calls).toHaveLength(0);
  expect(Object.keys(host!).sort()).toEqual(['cpuFraction', 'cpuModel', 'logicalCores', 'memTotalBytes', 'memUsedBytes', 'platform', 'sampledAt']);
  expect(host!.platform).toBe('Linux');
});

test('CPU share: a delta across all cores, re-primed after a long gap', () => {
  expect(cpuFraction(null, { idle: 80, total: 100 })).toBeNull();
  expect(cpuFraction({ idle: 80, total: 100 }, { idle: 150, total: 200 })).toBeCloseTo(0.3);
  expect(cpuFraction({ idle: 80, total: 100 }, { idle: 80, total: 100 })).toBeNull();
  expect(cpuFraction({ idle: 80, total: 100 }, { idle: 1, total: 2 })).toBeNull();
});

test('macmon streams for full-tier reads only; its reading and energy ride along', async () => {
  const children: Array<StreamChild & { stdout: PassThrough }> = [], spawned: Argv[] = [];
  const clock = { t: 0 };
  const sampler = new HostSampler({ exec: async argv => OUTPUT[argv.file] ?? null, now: () => EPOCH + clock.t, monotonic: () => clock.t,
    platform: 'darwin', home: HOME, macmon: '/opt/homebrew/bin/macmon',
    spawn: argv => {
      if (!allowed(argv, HOME)) return null;
      spawned.push(argv);
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: null, stdin: null, exitCode: null, signalCode: null,
        kill: () => true }) as unknown as StreamChild & { stdout: PassThrough };
      children.push(child);
      return child;
    } });
  await sampler.sample(context({ tier: 'glance' }));
  expect(spawned).toHaveLength(0);
  await sampler.sample(context());
  expect(spawned.map(argv => [argv.file, ...argv.args])).toEqual([['/opt/homebrew/bin/macmon', 'pipe', '-i', '1000']]);
  for (let second = 1; second <= 3; second++) {
    clock.t = second * 1_000;
    children[0]!.stdout.write('{"all_power":20.5,"ane_power":0.0,"cpu_power":2.5,"gpu_power":18.0,"sys_power":31.0}\n');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  const host = (await sampler.sample(context({ tier: 'glance' })))!;
  expect(host.power).toEqual({ sampledAt: EPOCH + 3_000, field: 'all_power', chipW: 20.5, cpuW: 2.5, gpuW: 18, aneW: 0, sysW: 31, coverageFraction: 0.3 });
  expect(hostCapabilities(host).find(({ key }) => key === 'host.power')).toEqual({ key: 'host.power', basis: 'estimate' });
  expect(sampler.energy(EPOCH, EPOCH + 3_000)).toEqual({ energyJ: 61.5, coverage: 1 });
  expect(spawned).toHaveLength(1);
  sampler.dispose();
  expect(await sampler.sample(context())).toMatchObject({ platform: 'macOS' });
});
