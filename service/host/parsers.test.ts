// Every macOS host probe fixture (tests/fixtures/host/macos-27) through the Stage 5 parsers. A new fixture fails the
// inventory test until it has an expectation here, and the PID canaries (4242, 4243) never leave a parser's output.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IOREG_MAX_BYTES } from '../lib/argv.ts';
import { parseFootprint, parseFootprintReport, parseLsofPids, sameProcess } from './footprint.ts';
import { parseIoreg } from './gpu.ts';
import { parseSysctl, parseVmStat } from './memory.ts';
import { parseMacmonLine } from './power.ts';
import { parseNotifyutil } from './thermal.ts';

const DIR = join(import.meta.dir, '../../tests/fixtures/host/macos-27');
const read = (name: string): string => readFileSync(join(DIR, name), 'utf8');
const AT = 1_790_690_700_000;
const GiB = 2 ** 30, MiB = 2 ** 20;
const lines = (text: string): string[] => text.split('\n').filter(Boolean);

/** fixture → what its parser must return. `ps.*` has no parser: `/bin/ps` is outside the G1 exec freeze. */
const EXPECTED: Record<string, () => unknown> = {
  'vm_stat.normal.txt': () => expect(parseVmStat(read('vm_stat.normal.txt'))).toEqual({ wiredBytes: 20_561_526_784, compressedBytes: 5_120_983_040 }),
  'vm_stat.no-mte.txt': () => expect(parseVmStat(read('vm_stat.no-mte.txt'))).toEqual({ wiredBytes: 18_060_673_024, compressedBytes: 3_421_700_096 }),
  'vm_stat.pressure.txt': () => expect(parseVmStat(read('vm_stat.pressure.txt'))).toEqual({ wiredBytes: 36_239_835_136, compressedBytes: 8_162_689_024 }),
  'sysctl.all-keys.txt': () => expect(parseSysctl(read('sysctl.all-keys.txt')))
    .toEqual({ pressureLevel: 1, wiredLimitBytes: 40_960 * MiB, swapUsedBytes: 0, swapTotalBytes: 0 }),
  'sysctl.pressure-2.txt': () => expect(parseSysctl(read('sysctl.pressure-2.txt')))
    .toEqual({ pressureLevel: 2, wiredLimitBytes: 42_949_672_960, swapUsedBytes: 3_163_815_936, swapTotalBytes: 4_294_967_296 }),
  'sysctl.pressure-4.txt': () => expect(parseSysctl(read('sysctl.pressure-4.txt')))
    .toEqual({ pressureLevel: 4, wiredLimitBytes: 42_949_672_960, swapUsedBytes: 10_288_103_424, swapTotalBytes: 10_737_418_240 }),
  // -i drops the unknown key silently; the others still parse (plan §5.4 test).
  'sysctl.missing-key.txt': () => expect(parseSysctl(read('sysctl.missing-key.txt')))
    .toEqual({ pressureLevel: 1, swapUsedBytes: 327_942_144, swapTotalBytes: 2_147_483_648 }),
  // 0 means "macOS default", not a 0-byte limit.
  'sysctl.wired-limit-default.txt': () => expect(parseSysctl(read('sysctl.wired-limit-default.txt')))
    .toEqual({ pressureLevel: 1, swapUsedBytes: 101_187_584, swapTotalBytes: 1_073_741_824 }),
  'ioreg.idle.txt': () => expect(parseIoreg(read('ioreg.idle.txt'), AT))
    .toEqual({ sampledAt: AT, busyFraction: 0.04, allocBytes: 28 * GiB, inUseBytes: GiB }),
  'ioreg.busy.txt': () => expect(parseIoreg(read('ioreg.busy.txt'), AT))
    .toEqual({ sampledAt: AT, busyFraction: 0.87, allocBytes: 31 * GiB, inUseBytes: 18 * GiB }),
  // Cut mid-number: "8" of 87 must never be read.
  'ioreg.truncated.txt': () => expect(parseIoreg(read('ioreg.truncated.txt'), AT)).toBeUndefined(),
  // Valid but over the 128 KiB cap: refused whole, never a prefix.
  'ioreg.oversize.txt': () => expect(parseIoreg(read('ioreg.oversize.txt'), AT)).toBeUndefined(),
  'ioreg.no-match.txt': () => expect(parseIoreg(read('ioreg.no-match.txt'), AT)).toBeUndefined(),
  'notifyutil.level-0.txt': () => expect(parseNotifyutil(read('notifyutil.level-0.txt'))).toBe(0),
  'notifyutil.level-1.txt': () => expect(parseNotifyutil(read('notifyutil.level-1.txt'))).toBe(1),
  'notifyutil.level-2.txt': () => expect(parseNotifyutil(read('notifyutil.level-2.txt'))).toBe(2),
  'notifyutil.level-3.txt': () => expect(parseNotifyutil(read('notifyutil.level-3.txt'))).toBe(3),
  'notifyutil.level-4.txt': () => expect(parseNotifyutil(read('notifyutil.level-4.txt'))).toBe(4),
  // Printed on stdout with exit 0: a failure, not a level.
  'notifyutil.failed.txt': () => expect(parseNotifyutil(read('notifyutil.failed.txt'))).toBeNull(),
  'notifyutil.out-of-range.txt': () => expect(parseNotifyutil(read('notifyutil.out-of-range.txt'))).toBeNull(),
  'lsof.listening.txt': () => expect(parseLsofPids(read('lsof.listening.txt'))).toEqual([4242]),
  'lsof.multiple.txt': () => expect(parseLsofPids(read('lsof.multiple.txt'))).toEqual([4242, 4243]),
  // Exit 1: readCommand returns null; the bytes are empty either way.
  'lsof.empty.txt': () => { expect(parseLsofPids(read('lsof.empty.txt'))).toEqual([]); expect(parseLsofPids(null)).toEqual([]); },
  'footprint.no-categories-bytes.txt': () => {
    expect(parseFootprint(read('footprint.no-categories-bytes.txt'))).toBe(20_008_894_464);
    expect(parseFootprintReport(read('footprint.no-categories-bytes.txt')))
      .toEqual({ name: 'python3', pid: 4242, footprintBytes: 20_008_894_464, peakBytes: 21_082_685_440 });
  },
  // Formatted units are rounded ("19 GB"): not bytes, so no reading rather than an invented precision.
  'footprint.no-categories.txt': () => expect(parseFootprint(read('footprint.no-categories.txt'))).toBeNull(),
  'footprint.loaded.txt': () => expect(parseFootprint(read('footprint.loaded.txt'))).toBeNull(),
  'footprint.unloaded.txt': () => expect(parseFootprint(read('footprint.unloaded.txt'))).toBeNull(),
  'footprint.not-found.txt': () => expect(parseFootprint(read('footprint.not-found.txt'))).toBeNull(),
  'macmon-pipe.normal.txt': () => {
    const samples = lines(read('macmon-pipe.normal.txt')).map(line => parseMacmonLine(line, AT));
    expect(samples).toHaveLength(3);
    for (const sample of samples) {
      expect(sample).toMatchObject({ sampledAt: AT, field: 'all_power' });
      expect(sample!.sysW!).toBeGreaterThanOrEqual(sample!.chipW);
      expect(Math.abs(sample!.chipW - (sample!.cpuW! + sample!.gpuW! + sample!.aneW!))).toBeLessThan(0.001);
      expect(Object.keys(sample!).sort()).toEqual(['aneW', 'chipW', 'cpuW', 'field', 'gpuW', 'sampledAt', 'sysW']);
    }
    expect(samples.some(sample => sample!.chipW === 28.282001)).toBe(true);
  },
  // sys_power 0.0 = SMC PSTR unreadable: shown only when > 0.
  'macmon-pipe.sys-power-zero.txt': () => {
    const samples = lines(read('macmon-pipe.sys-power-zero.txt')).map(line => parseMacmonLine(line, AT));
    expect(samples).toHaveLength(2);
    for (const sample of samples) { expect(sample!.chipW).toBeGreaterThan(0); expect('sysW' in sample!).toBe(false); }
  },
  // v0.7.2 tuples: the power fields are unchanged, so the same readings come out.
  'macmon-pipe.legacy.txt': () => expect(lines(read('macmon-pipe.legacy.txt')).map(line => parseMacmonLine(line, AT)))
    .toEqual(lines(read('macmon-pipe.normal.txt')).map(line => parseMacmonLine(line, AT))),
  'macmon-pipe.partial-line.txt': () => {
    const parts = read('macmon-pipe.partial-line.txt').split('\n');
    expect(parts.map(line => parseMacmonLine(line, AT) !== null)).toEqual([true, true, false]);
  },
  'ps.normal.txt': () => expect(read('ps.normal.txt')).toMatch(/^\w{3} \w{3} [ \d]\d /),
  'ps.single-digit-day.txt': () => expect(read('ps.single-digit-day.txt')).toContain('Oct  1'),
  'ps.not-found.txt': () => expect(read('ps.not-found.txt')).toBe(''),
};

describe('every host fixture has a parser expectation', () => {
  test('inventory', () => {
    expect(readdirSync(DIR).filter(name => name !== 'SOURCE.md').sort()).toEqual(Object.keys(EXPECTED).sort());
  });
  for (const [name, check] of Object.entries(EXPECTED)) test(name, () => { check(); });
});

test('no parser output carries a PID canary', () => {
  const outputs = readdirSync(DIR).filter(name => !name.startsWith('ps.') && name !== 'SOURCE.md').map(name => {
    const text = read(name);
    return name.startsWith('footprint.') ? parseFootprint(text) : name.startsWith('lsof.') ? null
      : [parseVmStat(text), parseSysctl(text), parseIoreg(text, AT), parseNotifyutil(text), ...lines(text).map(line => parseMacmonLine(line, AT))];
  });
  expect(JSON.stringify(outputs)).not.toMatch(/\b424[23]\b/);
});

describe('vm_stat and sysctl edge cases', () => {
  const vm = (page = '16384', wired = '100000') => `Mach Virtual Memory Statistics: (page size of ${page} bytes)\nPages wired down:${' '.repeat(28)}${wired}.\nPages occupied by compressor:${' '.repeat(17)}50000.\n`;
  test('the page size comes from the header; a missing, odd or huge one withholds both values', () => {
    expect(parseVmStat(vm('4096'))).toEqual({ wiredBytes: 409_600_000, compressedBytes: 204_800_000 });
    for (const page of ['0', '1234', '131072', '']) expect(parseVmStat(vm(page))).toEqual({});
    expect(parseVmStat(null)).toEqual({});
    expect(parseVmStat(vm('16384', '-5'))).toEqual({ compressedBytes: 819_200_000 });
    expect(parseVmStat(vm('16384', '1.5'))).toEqual({ compressedBytes: 819_200_000 });
    expect(parseVmStat(vm('16384', '99999999999999999'))).toEqual({ compressedBytes: 819_200_000 });
  });
  test('pressure is the kernel level 1/2/4 only; swap units are binary; malformed values are left out', () => {
    for (const level of ['0', '3', '8', '-1', '1.0', 'x']) expect(parseSysctl(`kern.memorystatus_vm_pressure_level: ${level}\n`)).toEqual({});
    expect(parseSysctl('vm.swapusage: total = 1.50G  used = 512.00K  free = 1.50G  (encrypted)\n'))
      .toEqual({ swapTotalBytes: 1.5 * GiB, swapUsedBytes: 512 * 1024 });
    expect(parseSysctl('vm.swapusage: total = -1.00M  used = x  free = 0.00M\n')).toEqual({});
    expect(parseSysctl('iogpu.wired_limit_mb: 040960\n')).toEqual({});
    expect(parseSysctl('sysctl: unknown oid\n')).toEqual({});
  });
});

describe('ioreg traps', () => {
  const node = (stats: string, extra = '') => `+-o AGXAcceleratorG17X  <class AGXAcceleratorG17X, id 0x1, registered, matched, active, busy 0 (1 ms), retain 9>\n    {\n${extra}      "PerformanceStatistics" = {${stats}}\n    }\n    \n\n`;
  test('exact keys: "(driver)" and the legend channel names never feed a value', () => {
    expect(parseIoreg(node('"In use system memory (driver)"=5,"Device Utilization %"=10'), AT)).toEqual({ sampledAt: AT, busyFraction: 0.1 });
    const legend = '      "IOReportLegend" = ({"IOReportChannels"=((1,2,"Alloc system memory"),(3,4,"In use system memory"))})\n';
    expect(parseIoreg(node('"Renderer Utilization %"=40', legend), AT)).toEqual({ sampledAt: AT, busyFraction: 0.4 });
  });
  test('renderer is the fallback; over 100 %, above 2^53 or two accelerators read as absent', () => {
    expect(parseIoreg(node('"Device Utilization %"=101,"Alloc system memory"=18446744071562067968'), AT)).toBeUndefined();
    expect(parseIoreg(node('"Device Utilization %"=50') + node('"Device Utilization %"=10'), AT)).toBeUndefined();
    expect(parseIoreg(node('"recoveryCount"=1'), AT)).toBeUndefined();
    expect(parseIoreg('x'.repeat(IOREG_MAX_BYTES + 1), AT)).toBeUndefined();
  });
});

describe('lsof and footprint', () => {
  test('lsof output with anything but PIDs is untrusted', () => {
    expect(parseLsofPids('4242\n4242\n')).toEqual([4242]);
    for (const text of ['4242\nCOMMAND\n', 'p4242\n', '1\n', '0\n', '99999999\n', '-4242\n']) expect(parseLsofPids(text)).toEqual([]);
  });
  test('a report needs one header, matching aux values and a peak at least the footprint', () => {
    const report = read('footprint.no-categories-bytes.txt');
    expect(parseFootprintReport(report.replace('phys_footprint: 20008894464', 'phys_footprint: 20008894465'))).toBeNull();
    expect(parseFootprintReport(report.replace('21082685440', '1'))).toBeNull();
    expect(parseFootprintReport(report + report)).toBeNull();
    expect(parseFootprintReport(report.replace('python3 [4242]', 'omlx server [4242]'))?.name).toBe('omlx server');
  });
  test('the reuse guard: same PID, same name, and a lifetime peak that never shrinks', () => {
    const first = parseFootprintReport(read('footprint.no-categories-bytes.txt'))!;
    expect(sameProcess(first, { ...first, footprintBytes: 1, peakBytes: first.peakBytes + 1 })).toBe(true);
    expect(sameProcess(first, { ...first, peakBytes: first.peakBytes - 16_384 })).toBe(false);
    expect(sameProcess(first, { ...first, name: 'node' })).toBe(false);
    expect(sameProcess(first, { ...first, pid: 4243 })).toBe(false);
  });
});

test('macmon lines: only complete JSON objects with a finite all_power', () => {
  expect(parseMacmonLine('{"all_power":1.5}', AT)).toEqual({ sampledAt: AT, field: 'all_power', chipW: 1.5 });
  for (const line of ['', '{', '{"all_power":-1}', '{"all_power":"5"}', '{"cpu_power":2}', '[1]', 'null', '{"all_power":1e9}', ' {"all_power":1}']) {
    expect(parseMacmonLine(line, AT)).toBeNull();
  }
  expect(parseMacmonLine('{"all_power":3,"cpu_power":-1,"gpu_power":null,"sys_power":2}', AT)).toEqual({ sampledAt: AT, field: 'all_power', chipW: 3, sysW: 2 });
});
