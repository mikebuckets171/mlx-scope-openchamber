// Host telemetry fixture corpus (macOS 27): shape, provenance and canary checks.
// The files are exact probe output (see macos-27/SOURCE.md). These tests prove the corpus is what the Stage 5 adapters
// will be tested against: the SPIKES S9 shapes are intact, every trap is present, and every privacy canary is planted
// exactly where intended, so adapter tests can prove it never leaks.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dir, 'macos-27');
const read = (name: string): string => readFileSync(join(DIR, name), 'utf8');
const lines = (text: string): string[] => text.split('\n').slice(0, -1);   // every complete, newline-terminated line
const FIXTURES = readdirSync(DIR).filter(name => name !== 'SOURCE.md').sort();
const COMMANDS = ['vm_stat', 'sysctl', 'ioreg', 'notifyutil', 'lsof', 'footprint', 'ps', 'macmon-pipe'] as const;
const byCommand = (command: (typeof COMMANDS)[number]) => FIXTURES.filter(name => name.startsWith(`${command}.`));

const PID_CANARY = 4242;
const SECOND_PID_CANARY = 4243;
const IOREG_CAP_BYTES = 128 * 1024;                       // contract §8 ioreg cap

describe('inventory and provenance', () => {
  test('every fixture is <command>.<variant>.txt for a G1-allowlisted probe', () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
    for (const name of FIXTURES) {
      expect(name).toMatch(/^[a-z_-]+\.[a-z0-9-]+\.txt$/);
      expect(COMMANDS.some(command => name.startsWith(`${command}.`))).toBe(true);
    }
  });

  test('SOURCE.md documents every fixture, and every documented fixture exists', () => {
    const source = read('SOURCE.md');
    const documented = new Set([...source.matchAll(/^\| `([a-z_-]+\.[a-z0-9-]+\.txt)` \|/gm)].map(m => m[1]!));
    expect([...documented].sort()).toEqual(FIXTURES);
    for (const heading of ['Privacy canaries', 'Provenance', 'Synthetic only']) expect(source).toContain(heading);
    expect(source).toMatch(/Version represented:\*\* macOS 27/);
  });

  test('any JSON file in the family parses (none today; NDJSON lives in .txt and is checked below)', () => {
    for (const name of readdirSync(DIR).filter(n => n.endsWith('.json'))) expect(() => JSON.parse(read(name))).not.toThrow();
  });
});

describe('synthetic only', () => {
  const all = FIXTURES.map(name => [name, read(name)] as const);

  test('no home paths, usernames, absolute paths, hostnames or private addresses', () => {
    for (const [name, text] of all) {
      expect({ name, hit: /\/(?:Users|home|private|Volumes|opt|var\/folders)\/[^\s"']*/.exec(text)?.[0] ?? null }).toEqual({ name, hit: null });
      expect({ name, hit: /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/.exec(text)?.[0] ?? null }).toEqual({ name, hit: null });
      expect({ name, hit: /\.local\b|\bLAN\b/.exec(text)?.[0] ?? null }).toEqual({ name, hit: null });
    }
  });

  test('no model ids, keys, tokens, cookies or prompt text', () => {
    for (const [name, text] of all) {
      expect({ name, hit: /\b[\w.-]+\/[\w.-]*\d+(?:\.\d+)?[BbMm]\b/.exec(text)?.[0] ?? null }).toEqual({ name, hit: null });
      expect({ name, hit: /\b(?:sk|ghp|gho|xox[abp])-?[A-Za-z0-9]{12,}|Bearer\s|Cookie:|api_key|CANARY-PROMPT/i.exec(text)?.[0] ?? null })
        .toEqual({ name, hit: null });
    }
  });

  test('every PID-bearing position holds a canary PID', () => {
    const pids: number[] = [];
    for (const [name, text] of all) {
      for (const m of text.matchAll(/"fLastSubmissionPID"=(\d+)/g)) pids.push(Number(m[1]));
      for (const m of text.matchAll(/^\S+ \[(\d+)\]: /gm)) pids.push(Number(m[1]));
      for (const m of text.matchAll(/matching '(\d+)'/g)) pids.push(Number(m[1]));
      if (name.startsWith('lsof.')) pids.push(...lines(text).map(Number));
    }
    expect(pids.length).toBeGreaterThan(8);
    expect([...new Set(pids)].sort()).toEqual([PID_CANARY, SECOND_PID_CANARY]);
  });
});

describe('privacy canaries are planted where intended', () => {
  const PLANTED: Record<string, RegExp> = {
    'ioreg.idle.txt': /"AGCInfo" = \{"fLastSubmissionPID"=4242,/,
    'ioreg.busy.txt': /"AGCInfo" = \{"fLastSubmissionPID"=4242,/,
    'ioreg.oversize.txt': /"AGCInfo" = \{"fLastSubmissionPID"=4242,/,
    'ioreg.truncated.txt': /"AGCInfo" = \{"fLastSubmissionPID"=4242,/,   // AGCInfo precedes the cut
    'lsof.listening.txt': /^4242\n$/,
    'lsof.multiple.txt': /^4242\n4243\n$/,
    'footprint.loaded.txt': /^python3 \[4242\]: 64-bit/m,
    'footprint.unloaded.txt': /^python3 \[4242\]: 64-bit/m,
    'footprint.no-categories.txt': /^python3 \[4242\]: 64-bit/m,
    'footprint.no-categories-bytes.txt': /^python3 \[4242\]: 64-bit/m,
    'footprint.not-found.txt': /matching '4242'/,
  };
  for (const [name, pattern] of Object.entries(PLANTED)) {
    test(name, () => expect(read(name)).toMatch(pattern));
  }

  test('and nowhere else', () => {
    for (const name of FIXTURES.filter(n => !(n in PLANTED))) {
      expect({ name, hit: /\b424[23]\b/.exec(read(name))?.[0] ?? null }).toEqual({ name, hit: null });
    }
  });
});

describe('vm_stat', () => {
  const ORDER = ['Pages free:', 'Pages active:', 'Pages inactive:', 'Pages speculative:', 'Pages throttled:',
    'Pages wired down:', 'Pages purgeable:', '"Translation faults":', 'Pages copy-on-write:', 'Pages zero filled:',
    'Pages reactivated:', 'Pages purged:', 'File-backed pages:', 'Anonymous pages:', 'Pages stored in compressor:',
    'Pages occupied by compressor:', 'Decompressions:', 'Compressions:', 'Pageins:', 'Pageouts:', 'Swapins:', 'Swapouts:'];
  const MTE = ['Pages tagged:', 'Pages tagged resident:', 'Pages tagged compressed:', 'Pages tag-storage:',
    'Pages tag-storage holding tags:', 'Pages tag-storage free:', 'Pages tag-storage non-tag pageable:',
    'Pages tag-storage non-tag wired:', 'Bytes of compressed tags:', 'Tagged compressions:', 'Tagged decompressions:'];
  const parse = (text: string) => {
    const [header, ...rows] = lines(text);
    expect(header).toBe('Mach Virtual Memory Statistics: (page size of 16384 bytes)');
    return rows.map(row => {
      expect(row).toHaveLength(53);                                   // "%-35s %16llu.\n"
      const m = /^(.{35}) ([ \d]{16})\.$/.exec(row);
      expect(m).not.toBeNull();
      const value = Number(m![2]!.trim());
      expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
      expect(Number.isSafeInteger(value * 16384)).toBe(true);
      return [m![1]!.trimEnd(), value] as const;
    });
  };

  test('variants', () => expect(byCommand('vm_stat')).toEqual(['vm_stat.no-mte.txt', 'vm_stat.normal.txt', 'vm_stat.pressure.txt']));

  test('labels follow vm_stat.c order; the MTE block appears only on MTE hardware', () => {
    expect(parse(read('vm_stat.normal.txt')).map(([label]) => label)).toEqual([...ORDER, ...MTE]);
    expect(parse(read('vm_stat.pressure.txt')).map(([label]) => label)).toEqual([...ORDER, ...MTE]);
    expect(parse(read('vm_stat.no-mte.txt')).map(([label]) => label)).toEqual(ORDER);
  });

  test('pressure variant is under pressure relative to normal', () => {
    const normal = new Map(parse(read('vm_stat.normal.txt')));
    const pressure = new Map(parse(read('vm_stat.pressure.txt')));
    expect(pressure.get('Pages free:')!).toBeLessThan(normal.get('Pages free:')! / 10);
    expect(pressure.get('Pages wired down:')!).toBeGreaterThan(normal.get('Pages wired down:')!);
    expect(pressure.get('Pages occupied by compressor:')!).toBeGreaterThan(normal.get('Pages occupied by compressor:')!);
    expect(pressure.get('Swapouts:')!).toBeGreaterThan(normal.get('Swapouts:')!);
    expect(normal.get('Pages wired down:')! * 16384).toBe(20_561_526_784);
  });
});

describe('sysctl -i', () => {
  const ARGV = ['vm.swapusage', 'kern.memorystatus_vm_pressure_level', 'kern.memorystatus_level', 'iogpu.wired_limit_mb'];
  const SWAP = /^total = (\d+\.\d{2})M {2}used = (\d+\.\d{2})M {2}free = (\d+\.\d{2})M {2}\(encrypted\)$/;
  const EXPECTED: Record<string, { pressure: 1 | 2 | 4; wiredMb: number | null; totalM: number; usedM: number }> = {
    'sysctl.all-keys.txt': { pressure: 1, wiredMb: 40960, totalM: 0, usedM: 0 },
    'sysctl.pressure-2.txt': { pressure: 2, wiredMb: 40960, totalM: 4096, usedM: 3017.25 },
    'sysctl.pressure-4.txt': { pressure: 4, wiredMb: 40960, totalM: 10240, usedM: 9811.5 },
    'sysctl.missing-key.txt': { pressure: 1, wiredMb: null, totalM: 2048, usedM: 312.75 },
    'sysctl.wired-limit-default.txt': { pressure: 1, wiredMb: 0, totalM: 1024, usedM: 96.5 },
  };
  const parse = (text: string) => lines(text).map(line => {
    const m = /^([a-z_.]+): (.+)$/.exec(line);
    expect(m).not.toBeNull();
    return [m![1]!, m![2]!] as const;
  });

  test('variants', () => expect(byCommand('sysctl')).toEqual(Object.keys(EXPECTED).sort()));

  for (const [name, want] of Object.entries(EXPECTED)) {
    test(name, () => {
      const rows = parse(read(name));
      const keys = rows.map(([key]) => key);
      expect(keys).toEqual(ARGV.filter(key => key !== 'iogpu.wired_limit_mb' || want.wiredMb !== null));   // argv order, -i drops unknown
      const values = new Map(rows);
      const swap = SWAP.exec(values.get('vm.swapusage')!);
      expect(swap).not.toBeNull();
      const [total, used, free] = swap!.slice(1).map(Number) as [number, number, number];
      expect([total, used]).toEqual([want.totalM, want.usedM]);
      expect(Math.abs(total - used - free)).toBeLessThan(0.006);
      const pressure = Number(values.get('kern.memorystatus_vm_pressure_level'));
      expect([1, 2, 4]).toContain(pressure);
      expect(pressure).toBe(want.pressure);
      const level = Number(values.get('kern.memorystatus_level'));
      expect(Number.isInteger(level) && level >= 0 && level <= 100).toBe(true);
      expect(values.has('iogpu.wired_limit_mb') ? Number(values.get('iogpu.wired_limit_mb')) : null).toBe(want.wiredMb);
    });
  }
});

describe('ioreg IOAccelerator', () => {
  const HEADER = /^\+-o (AGXAccelerator\w+) {2}<class \1, id 0x[0-9a-f]+, registered, matched, active, busy \d+ \(\d+ ms\), retain \d+>$/;
  const REQUIRED = ['Device Utilization %', 'Renderer Utilization %', 'Tiler Utilization %', 'Alloc system memory',
    'In use system memory', 'In use system memory (driver)', 'recoveryCount'];
  /** A flat `{"key"=int,...}` dictionary on one closed line, or null. */
  const perf = (text: string): Map<string, number> | null => {
    const m = /^ {6}"PerformanceStatistics" = \{(.*)\}$/m.exec(text);
    if (!m) return null;
    return new Map(m[1]!.split(',').map(pair => {
      const kv = /^"([^"]+)"=(\d+)$/.exec(pair);
      expect(kv).not.toBeNull();
      return [kv![1]!, Number(kv![2])] as const;
    }));
  };
  const complete = (text: string) => {
    const rows = text.split('\n');
    expect(rows[0]).toMatch(HEADER);
    expect(rows[1]).toBe('    {');
    expect(text.endsWith('\n    }\n    \n\n')).toBe(true);
    for (const row of rows.slice(2, -4)) expect(row).toMatch(/^ {6}"[^"]+" = .+$/);
  };

  test('variants', () => expect(byCommand('ioreg')).toEqual(
    ['ioreg.busy.txt', 'ioreg.idle.txt', 'ioreg.no-match.txt', 'ioreg.oversize.txt', 'ioreg.truncated.txt']));

  test('idle and busy are realistic ~45 KB single nodes under the 128 KiB cap', () => {
    for (const name of ['ioreg.idle.txt', 'ioreg.busy.txt']) {
      const text = read(name);
      complete(text);
      expect(Buffer.byteLength(text)).toBeGreaterThan(40_000);
      expect(Buffer.byteLength(text)).toBeLessThan(IOREG_CAP_BYTES);
      expect(text.match(/^\+-o /gm)).toHaveLength(1);
    }
  });

  test('PerformanceStatistics carries every required key as a safe integer', () => {
    for (const name of ['ioreg.idle.txt', 'ioreg.busy.txt', 'ioreg.oversize.txt']) {
      const stats = perf(read(name));
      expect(stats).not.toBeNull();
      for (const key of REQUIRED) {
        expect(stats!.has(key)).toBe(true);
        expect(Number.isSafeInteger(stats!.get(key))).toBe(true);
      }
      for (const key of REQUIRED.filter(k => k.endsWith('%'))) expect(stats!.get(key)!).toBeLessThanOrEqual(100);
    }
    const idle = perf(read('ioreg.idle.txt'))!, busy = perf(read('ioreg.busy.txt'))!;
    expect(idle.get('Device Utilization %')).toBe(4);
    expect(busy.get('Device Utilization %')).toBe(87);
    expect(busy.get('Renderer Utilization %')).toBe(85);
    expect(busy.get('Tiler Utilization %')).toBe(12);
    expect(busy.get('Alloc system memory')).toBe(33_285_996_544);
    expect(busy.get('In use system memory')).toBe(19_327_352_832);
    expect(busy.get('In use system memory (driver)')).toBe(0);
    expect(busy.get('recoveryCount')).toBe(1);
  });

  test('traps: prefix-colliding keys, legend channel names, integers above 2^53', () => {
    const text = read('ioreg.busy.txt');
    const line = /^ {6}"PerformanceStatistics" = .*$/m.exec(text)![0];
    expect(line.indexOf('"In use system memory (driver)"=')).toBeLessThan(line.indexOf('"In use system memory"='));
    const legend = /^ {6}"IOReportLegend" = .*$/m.exec(text)![0];
    expect(legend).toContain('"Alloc system memory")');
    expect(legend).toContain('"In use system memory")');
    expect(legend).not.toMatch(/"(?:Alloc|In use) system memory"=/);
    expect(text).toContain('"AGXParameterBufferMaxSize" = 18446744071562067968');
    expect(Number.isSafeInteger(Number('18446744071562067968'))).toBe(false);
    expect(read('ioreg.idle.txt')).toContain('"SchedulerState" = {"Stamps"=(),"BusyWorkQueues"=()}');
  });

  test('truncated: a prefix of busy, cut mid-number with the dictionary left open', () => {
    const busy = read('ioreg.busy.txt'), cut = read('ioreg.truncated.txt');
    expect(busy.startsWith(cut)).toBe(true);
    expect(cut.length).toBeLessThan(busy.length);
    expect(cut.endsWith('"Device Utilization %"=8')).toBe(true);
    expect(cut.endsWith('\n')).toBe(false);
    expect(perf(cut)).toBeNull();                                      // a closed-dict parser yields nothing
  });

  test('oversize: complete and valid, but over the 128 KiB cap', () => {
    const text = read('ioreg.oversize.txt');
    complete(text);
    expect(Buffer.byteLength(text)).toBeGreaterThan(IOREG_CAP_BYTES);
    expect(Buffer.byteLength(text)).toBeLessThan(IOREG_CAP_BYTES + 16 * 1024);
    expect(perf(text)!.get('Device Utilization %')).toBe(87);
  });

  test('no-match is empty output', () => expect(read('ioreg.no-match.txt')).toBe(''));
});

describe('notifyutil thermal pressure', () => {
  const KEY = 'com.apple.system.thermalpressurelevel';
  test('variants', () => expect(byCommand('notifyutil')).toEqual([
    'notifyutil.failed.txt', 'notifyutil.level-0.txt', 'notifyutil.level-1.txt', 'notifyutil.level-2.txt',
    'notifyutil.level-3.txt', 'notifyutil.level-4.txt', 'notifyutil.out-of-range.txt']));
  for (const level of [0, 1, 2, 3, 4]) {
    test(`level ${level} is exactly "<key> <n>\\n"`, () => expect(read(`notifyutil.level-${level}.txt`)).toBe(`${KEY} ${level}\n`));
  }
  test('failure is printed on stdout and does not look like a level', () => {
    const text = read('notifyutil.failed.txt');
    expect(text).toMatch(new RegExp(`^${KEY.replaceAll('.', '\\.')}: Failed with code \\d+\\n$`));
    expect(text).not.toMatch(new RegExp(`^${KEY.replaceAll('.', '\\.')} \\d+$`, 'm'));
  });
  test('out-of-range value is well-formed but outside 0–4', () => {
    const m = new RegExp(`^${KEY.replaceAll('.', '\\.')} (\\d+)\\n$`).exec(read('notifyutil.out-of-range.txt'));
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(4);
  });
});

describe('lsof listener PID', () => {
  test('variants', () => expect(byCommand('lsof')).toEqual(['lsof.empty.txt', 'lsof.listening.txt', 'lsof.multiple.txt']));
  test('one PID per line, nothing else', () => {
    expect(lines(read('lsof.listening.txt'))).toEqual([String(PID_CANARY)]);
    expect(lines(read('lsof.multiple.txt'))).toEqual([String(PID_CANARY), String(SECOND_PID_CANARY)]);
    expect(read('lsof.empty.txt')).toBe('');
  });
});

describe('ps -o lstart=', () => {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const LSTART = /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ([ \d]\d) (\d\d):(\d\d):(\d\d) (\d{4})$/;
  const check = (text: string) => {
    expect(text).toHaveLength(29);                                    // "%-28s" + "\n"
    expect(text.endsWith('    \n')).toBe(true);
    const m = LSTART.exec(text.slice(0, 24))!;
    expect(m).not.toBeNull();
    const [, day, month, date, , , , year] = m;
    const weekday = new Date(Date.UTC(Number(year), MONTHS.indexOf(month!), Number(date))).getUTCDay();
    expect(DAYS[weekday]).toBe(day!);
    return text.slice(0, 24);
  };
  test('variants', () => expect(byCommand('ps')).toEqual(['ps.normal.txt', 'ps.not-found.txt', 'ps.single-digit-day.txt']));
  test('normal', () => expect(check(read('ps.normal.txt'))).toBe('Tue Sep 29 08:15:42 2026'));
  test('single-digit day is space-padded (%e)', () => expect(check(read('ps.single-digit-day.txt'))).toContain('Oct  1'));
  test('not-found is empty', () => expect(read('ps.not-found.txt')).toBe(''));
});

describe('footprint', () => {
  const HEADER = /^={70}\n(\S+) \[(\d+)\]: 64-bit {4}Footprint: (\d+ (?:B|KB|MB|GB)) \(16384 bytes per page\)\n={70}\n\n/;
  const AUX = /Auxiliary data:\n {4}phys_footprint: (\d+ (?:B|KB|MB|GB))\n {4}phys_footprint_peak: (\d+ (?:B|KB|MB|GB))\n\n$/;
  const UNIT: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
  const bytes = (value: string) => { const [n, u] = value.split(' '); return Number(n) * UNIT[u!]!; };
  /** footprint's formatted unit: rounded whole number, next unit from 10 × 1024 of the current one. */
  const formatted = (n: number) => { let v = n, i = 0; const u = ['B', 'KB', 'MB', 'GB']; while (v >= 10240 && i < 3) { v /= 1024; i++; } return `${Math.round(v)} ${u[i]}`; };
  const parse = (name: string) => {
    const text = read(name);
    const h = HEADER.exec(text), a = AUX.exec(text);
    expect(h).not.toBeNull();
    expect(a).not.toBeNull();
    expect(h![1]).toBe('python3');
    expect(Number(h![2])).toBe(PID_CANARY);
    expect(h![3]).toBe(a![1]!);                                       // header Footprint == phys_footprint
    return { text, footprint: a![1]!, peak: a![2]! };
  };

  test('variants', () => expect(byCommand('footprint')).toEqual(['footprint.loaded.txt', 'footprint.no-categories-bytes.txt',
    'footprint.no-categories.txt', 'footprint.not-found.txt', 'footprint.unloaded.txt']));

  test('category tables: header, rules and a TOTAL row equal to the footprint', () => {
    for (const name of ['footprint.loaded.txt', 'footprint.unloaded.txt']) {
      const { text, footprint } = parse(name);
      expect(text).toContain('  Dirty      Clean  Reclaimable    Regions    Category\n    ---        ---          ---        ---    ---\n');
      const total = /^ *(\d+ (?:B|KB|MB|GB)) +\d+ (?:B|KB|MB|GB) +\d+ (?:B|KB|MB|GB) +\d+ {4}TOTAL$/m.exec(text);
      expect(total).not.toBeNull();
      expect(total![1]).toBe(footprint);
      // default --sort dirty: rows with dirty memory come first, largest first
      const dirty = [...text.matchAll(/^ *(\d+ (?:B|KB|MB|GB)) +\d+ (?:B|KB|MB|GB) +\d+ (?:B|KB|MB|GB) +\d+ {4}(?!TOTAL)\S.*$/gm)]
        .map(m => bytes(m[1]!));
      expect(dirty.length).toBeGreaterThan(20);
      expect(dirty).toEqual([...dirty].sort((a, b) => b - a));
    }
  });

  test('loaded vs unloaded: the peak outlives the model', () => {
    const loaded = parse('footprint.loaded.txt'), unloaded = parse('footprint.unloaded.txt');
    expect([loaded.footprint, loaded.peak]).toEqual(['19 GB', '20 GB']);
    expect([unloaded.footprint, unloaded.peak]).toEqual(['275 MB', '20 GB']);
    expect(bytes(unloaded.peak)).toBeGreaterThan(bytes(unloaded.footprint) * 50);
  });

  test('--noCategories has no table; its values match the exact-bytes form', () => {
    const plain = parse('footprint.no-categories.txt'), exact = parse('footprint.no-categories-bytes.txt');
    for (const { text } of [plain, exact]) expect(text).not.toContain('Category');
    const current = Number(exact.footprint.replace(' B', '')), peak = Number(exact.peak.replace(' B', ''));
    for (const n of [current, peak]) {
      expect(Number.isSafeInteger(n)).toBe(true);
      expect(n % 16384).toBe(0);
    }
    expect(peak).toBeGreaterThanOrEqual(current);
    expect([formatted(current), formatted(peak)]).toEqual([plain.footprint, plain.peak]);
    expect(parse('footprint.loaded.txt').footprint).toBe(plain.footprint);
  });

  test('not-found is the two-line stderr message', () => {
    expect(read('footprint.not-found.txt')).toBe(
      "footprint: Unable to find pid for process matching '4242'\n"
      + 'footprint: Unable to find any processes matching the supplied process names or pids (try as root?)\n');
  });
});

describe('macmon pipe NDJSON', () => {
  const POWER = ['cpu_power', 'gpu_power', 'ane_power', 'all_power', 'sys_power', 'ram_power', 'gpu_ram_power'] as const;
  const V08_ONLY = ['cpu_active_ratio', 'cpu_scaled_ratio', 'ecpu_active_ratio', 'ecpu_cores', 'ecpu_freq_mhz',
    'ecpu_scaled_ratio', 'fans', 'gpu_active_ratio', 'gpu_freq_mhz', 'gpu_scaled_ratio', 'pcpu_active_ratio', 'pcpu_cores',
    'pcpu_freq_mhz', 'pcpu_scaled_ratio'];
  const ALIASES = ['cpu_usage_pct', 'ecpu_usage', 'pcpu_usage', 'gpu_usage'];
  type Line = Record<string, unknown>;
  const records = (name: string): Line[] => {
    const text = read(name);
    expect(text.endsWith('\n')).toBe(true);
    return lines(text).map(line => JSON.parse(line) as Line);
  };
  const sortedDeep = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.every(sortedDeep);
    if (value && typeof value === 'object') {
      const keys = Object.keys(value);
      return keys.join('\0') === [...keys].sort().join('\0') && Object.values(value).every(sortedDeep);
    }
    return true;
  };
  const f32Sum = (...xs: number[]) => xs.reduce((a, b) => Math.fround(a + b));
  const common = (line: Line) => {
    expect(sortedDeep(line)).toBe(true);                               // serde_json BTreeMap: keys sorted at every level
    for (const key of POWER) {
      expect(typeof line[key]).toBe('number');
      expect(line[key] as number).toBeGreaterThanOrEqual(0);
    }
    // all_power = cpu + gpu + ane in f32 (metrics.rs:185); JSON carries the shortest f32 text, so compare as f32.
    expect(Math.fround(line.all_power as number)).toBe(f32Sum(Math.fround(line.cpu_power as number),
      Math.fround(line.gpu_power as number), Math.fround(line.ane_power as number)));
    const temp = line.temp as Record<string, unknown>;
    expect(typeof temp.cpu_temp_avg).toBe('number');
    expect(typeof temp.gpu_temp_avg).toBe('number');
    const memory = line.memory as Record<string, unknown>;
    for (const key of ['ram_total', 'ram_usage', 'swap_total', 'swap_usage']) expect(Number.isSafeInteger(memory[key])).toBe(true);
    expect(line.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,9}\+00:00$/);
    for (const key of ALIASES.slice(1)) {
      const [mhz, ratio] = line[key] as [number, number];
      expect(Number.isInteger(mhz)).toBe(true);
      expect(ratio >= 0 && ratio <= 1).toBe(true);
    }
  };
  const v08 = (line: Line) => {
    common(line);
    for (const key of [...V08_ONLY, ...ALIASES]) expect(key in line).toBe(true);
    const ratio = line.gpu_active_ratio as number;
    expect(ratio >= 0 && ratio <= 1).toBe(true);
    expect(Number.isInteger(line.gpu_freq_mhz)).toBe(true);
    expect(line.cpu_usage_pct).toBe(line.cpu_scaled_ratio as number);
    for (const fan of line.fans as Array<Record<string, unknown>>) {
      expect(fan.name).toMatch(/^fan\d+$/);
      expect(Number.isInteger(fan.rpm)).toBe(true);
      expect(fan.max_rpm === null || Number.isInteger(fan.max_rpm)).toBe(true);
    }
    for (const core of [...(line.ecpu_cores as Line[]), ...(line.pcpu_cores as Line[])]) {
      expect(Object.keys(core)).toEqual(['active_ratio', 'core_id', 'die_id', 'freq_mhz', 'scaled_ratio']);
    }
  };

  test('variants', () => expect(byCommand('macmon-pipe')).toEqual(['macmon-pipe.legacy.txt', 'macmon-pipe.normal.txt',
    'macmon-pipe.partial-line.txt', 'macmon-pipe.sys-power-zero.txt']));

  test('normal (v0.8.2): every power field; sys_power is the SMC estimate ≥ all_power', () => {
    const rows = records('macmon-pipe.normal.txt');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      v08(row);
      expect(row.sys_power as number).toBeGreaterThan(0);
      expect(row.sys_power as number).toBeGreaterThanOrEqual(row.all_power as number);
      expect(row.gpu_power as number).toBeGreaterThan(20);             // decode load
    }
    const times = rows.map(row => Date.parse(row.timestamp as string));
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThan(900);
    expect(read('macmon-pipe.normal.txt')).toContain('"all_power":28.282001,');   // f32 sum, shortest round-trip
  });

  test('sys-power-zero: PSTR unreadable → 0.0, serialized with the f32 ".0"', () => {
    const rows = records('macmon-pipe.sys-power-zero.txt');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      v08(row);
      expect(row.sys_power).toBe(0);
      expect(row.all_power as number).toBeGreaterThan(0);
    }
    for (const line of lines(read('macmon-pipe.sys-power-zero.txt'))) expect(line).toContain('"sys_power":0.0,');
  });

  test('legacy (v0.7.2): tuple fields and power, no v0.8-only fields', () => {
    const rows = records('macmon-pipe.legacy.txt');
    expect(rows).toHaveLength(3);
    const normal = records('macmon-pipe.normal.txt');
    rows.forEach((row, i) => {
      common(row);
      for (const key of V08_ONLY) expect(key in row).toBe(false);
      for (const key of POWER) expect(row[key]).toBe(normal[i]![key]);
      expect(row.timestamp).toBe(normal[i]!.timestamp);
    });
  });

  test('partial-line: complete lines parse; the cut fragment does not', () => {
    const text = read('macmon-pipe.partial-line.txt');
    expect(text.endsWith('\n')).toBe(false);
    const parts = text.split('\n');
    expect(parts).toHaveLength(3);
    parts.slice(0, 2).forEach(part => v08(JSON.parse(part) as Line));
    expect(parts[2]!.startsWith('{')).toBe(true);
    expect(parts[2]!.endsWith('"gpu_power":2')).toBe(true);
    expect(() => JSON.parse(parts[2]!)).toThrow();
    expect(lines(read('macmon-pipe.normal.txt')).slice(0, 2)).toEqual(parts.slice(0, 2));
  });
});
