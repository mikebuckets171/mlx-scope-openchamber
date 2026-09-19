import { expect, test } from 'bun:test';
import { cpuUsage, SystemSampler } from './system.ts';
import { parseSystemSnapshot } from '../src/system.ts';

const cpu = (idle: number, user: number) => [{ model: 'Apple Silicon test fixture', speed: 0, times: { idle, user, nice: 0, sys: 0, irq: 0 } }];

test('CPU uses differences across all cores, not cumulative uptime', () => {
  expect(cpuUsage(null, { idle: 80, total: 100 })).toBeNull();
  expect(cpuUsage({ idle: 80, total: 100 }, { idle: 150, total: 200 })).toBeCloseTo(30);
  expect(cpuUsage({ idle: 80, total: 100 }, { idle: 80, total: 100 })).toBeNull();
  expect(cpuUsage({ idle: 80, total: 100 }, { idle: 1, total: 2 })).toBeNull();
  expect(cpuUsage({ idle: 0, total: 0 }, { idle: NaN, total: 2 })).toBeNull();
});

test('system sampling is shared, cached and re-primes CPU after suspension', async () => {
  let now = 10_000;
  let reads = 0;
  const sampler = new SystemSampler({ now: () => now, hostPlatform: 'linux',
    readCPUs: () => cpu(80 + 70 * reads, 20 + 30 * reads++), readFree: () => 8e9, readTotal: () => 48e9 });
  const pending = sampler.sample();
  expect(sampler.sample()).toBe(pending);
  const first = await pending;
  now += 1_000;
  expect(await sampler.sample()).toBe(first);
  expect(reads).toBe(1);
  now += 1_000;
  expect((await sampler.sample()).cpuPercent).toBeCloseTo(30);
  expect(first.cpuPercent).toBeNull();
  expect(first.memoryUsedGB).toBe(40);
  now += 60_000;
  expect((await sampler.sample()).cpuPercent).toBeNull();
  now -= 5_000;
  expect((await sampler.sample()).cpuPercent).toBeNull();
});

test('non-macOS hosts never execute native diagnostics', async () => {
  let nativeReads = 0;
  const sampler = new SystemSampler({ hostPlatform: 'linux', native: { sample: async () => { nativeReads++; throw Error('must not execute'); } } });
  expect((await sampler.sample()).macOS).toBeNull();
  expect(nativeReads).toBe(0);
});

test('macOS diagnostics failure does not remove portable host observations', async () => {
  const sampler = new SystemSampler({ hostPlatform: 'darwin', native: { sample: async () => { throw Error('denied'); } } });
  const snapshot = await sampler.sample();
  expect(snapshot.macOS).toBeNull();
  expect(snapshot.memoryTotalGB).toBeGreaterThan(0);
});

test('unknown CPU and contradictory memory are never invented', async () => {
  const snapshot = await new SystemSampler({ hostPlatform: 'linux', readCPUs: () => [], readFree: () => 5, readTotal: () => 2 }).sample();
  expect(snapshot.cpuPercent).toBeNull();
  expect(snapshot.logicalCores).toBeNull();
  expect(snapshot.memoryUsedGB).toBeNull();
});

test('browser boundary is idempotent, scalar-only and backwards compatible', () => {
  const first = parseSystemSnapshot({ platform: 'darwin', sampledAt: 20, cpuPercent: 30, memoryUsedGB: 40, memoryTotalGB: 48,
    cpuModel: '<test>\u0000', logicalCores: 18, raw: 'private',
    macOS: { wiredGB: 3, compressedGB: 2, swapUsedGB: 0, pressure: 'normal', sampledAt: 15, raw: 'secret' } })!;
  expect(first.platform).toBe('macOS');
  expect(first.cpuModel).toBe('<test>');
  expect(first.macOS?.swapUsedGB).toBe(0);
  expect(parseSystemSnapshot(first)).toEqual(first);
  expect(JSON.stringify(first)).not.toContain('secret');
  expect(parseSystemSnapshot({ ...first, cpuPercent: Infinity })?.cpuPercent).toBeNull();
  expect(parseSystemSnapshot({ ...first, cpuPercent: 101 })?.cpuPercent).toBeNull();
  expect(parseSystemSnapshot({ ...first, memoryUsedGB: 100 })?.memoryUsedGB).toBeNull();
  expect(parseSystemSnapshot({ ...first, platform: 'linux' })?.macOS).toBeNull();
  expect(parseSystemSnapshot({ platform: 'darwin', sampledAt: 0 })?.macOS).toBeNull();
  expect(parseSystemSnapshot({ ...first, platform: '__proto__' })?.platform).toBe('Host');
  expect(parseSystemSnapshot(null)).toBeNull();
  expect(parseSystemSnapshot([])).toBeNull();
});
