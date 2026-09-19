import { expect, test } from 'bun:test';
import { MacMemorySampler, parseVMStat, parseSysctlMemory, readNative } from './mac-memory.ts';

const vm = (size = 16384) => `Mach Virtual Memory Statistics: (page size of ${size} bytes)
Pages free: 123.
Pages wired down: 100000.
Pages stored in compressor: 900000.
Pages occupied by compressor: 50000.
`;
const sysctl = 'vm.swapusage: total = 3072.00M  used = 1024.50M  free = 2047.50M (encrypted)\n';

 test('16 KiB and 4 KiB pages use physical compressor footprint, not logical storage', () => {
  expect(parseVMStat(vm()).wiredGB).toBe(1.6384);
  expect(parseVMStat(vm()).compressedGB).toBe(0.8192);
  expect(parseVMStat(vm(4096)).wiredGB).toBe(0.4096);
});

test('missing, malformed, negative and overflowing VM values stay unavailable', () => {
  for (const output of [null, '', vm(0), vm(1234), vm(999999999999999999)]) {
    expect(parseVMStat(output)).toEqual({ wiredGB: null, compressedGB: null });
  }
  expect(parseVMStat(vm().replace('100000.', '-100.')).wiredGB).toBeNull();
  expect(parseVMStat(vm().replace('100000.', '100.5')).wiredGB).toBeNull();
  expect(parseVMStat(vm().replace('100000.', '999999999999999999999999.')).wiredGB).toBeNull();
  expect(parseVMStat(vm().replace('50000.', '0.')).compressedGB).toBe(0);
});

test('swap uses binary units and rejects malformed readings', () => {
  expect(parseSysctlMemory(sysctl)).toEqual({ swapUsedGB: 1024.5 * 1024 ** 2 / 1e9 });
  expect(parseSysctlMemory('vm.swapusage: used = 1.5G free = 0.5G').swapUsedGB).toBe(1.5 * 1024 ** 3 / 1e9);
  expect(parseSysctlMemory('vm.swapusage: used = 0.00M').swapUsedGB).toBe(0);
  expect(parseSysctlMemory('vm.swapusage: used = -1M').swapUsedGB).toBeNull();
  expect(parseSysctlMemory(null)).toEqual({ swapUsedGB: null });
});

test('native samples coalesce, use fixed commands, expire and cache failures', async () => {
  let now = 10_000;
  const calls: { file: string; args: readonly string[] }[] = [];
  let fail = false;
  const sampler = new MacMemorySampler(async (file, args) => {
    calls.push({ file, args });
    if (fail) throw Error('unavailable');
    return file.endsWith('vm_stat') ? vm() : sysctl;
  }, () => now);
  const pending = sampler.sample();
  expect(sampler.sample()).toBe(pending);
  const first = await pending;
  expect(calls).toEqual([
    { file: '/usr/bin/vm_stat', args: [] },
    { file: '/usr/sbin/sysctl', args: ['vm.swapusage'] },
  ]);
  now += 9_999;
  expect(await sampler.sample()).toBe(first);
  expect(calls).toHaveLength(2);
  now++;
  fail = true;
  const missing = await sampler.sample();
  expect(missing.wiredGB).toBeNull();
  expect(calls).toHaveLength(4);
  expect(await sampler.sample()).toBe(missing);
  now -= 100;
  await sampler.sample();
  expect(calls).toHaveLength(6);
});

test('native read fails closed for a nonexistent binary', async () => {
  expect(await readNative('/does-not-exist/mlx-scope', [])).toBeNull();
});

// Real macOS command reads are verified by scripts/smoke-service.mjs through
// the extracted Node service, matching OpenChamber's host runtime. The parser
// and bounded-reader behavior above remain independently tested under Bun.
