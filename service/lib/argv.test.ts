import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { Glob } from 'bun';
import { allowed, createExec, createStreamSpawn, EXEC_PATHS, footprintArgv, ioregArgv, LMS_HOME_PATHS, lmsArgv, lsofListenArgv,
  MACMON_PATHS, macmonArgv, notifyutilArgv, sysctlArgv, vmStatArgv, type Argv, type StreamChild } from './argv.ts';

const HOME = '/Users/someone';
const INFO = `${HOME}/.lmstudio/.internal/http-server.json`;
const LMS = `${HOME}/.lmstudio/bin/lms`;
const every = (): Argv[] => [vmStatArgv(), sysctlArgv(), ioregArgv(), notifyutilArgv(), lsofListenArgv(8001)!, lsofListenArgv(1)!,
  lsofListenArgv(65_535)!, footprintArgv(4242)!, footprintArgv(2)!, ...MACMON_PATHS.map(path => macmonArgv(path)!),
  ...LMS_HOME_PATHS.flatMap(relative => (['ps', 'runtime-ls', 'log-stream'] as const).map(command => lmsArgv(`${HOME}/${relative}`, command, 41_343, INFO)!))];

test('the builders produce the G1 argv exactly: absolute paths, fixed flags, validated port and PID', () => {
  expect(vmStatArgv()).toEqual({ file: '/usr/bin/vm_stat', args: [], timeoutMs: 1_500, maxBytes: 65_536 });
  expect(sysctlArgv().args).toEqual(['-i', 'vm.swapusage', 'kern.memorystatus_vm_pressure_level', 'iogpu.wired_limit_mb']);
  expect(ioregArgv()).toEqual({ file: '/usr/sbin/ioreg', args: ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], timeoutMs: 1_500, maxBytes: 131_072 });
  expect(notifyutilArgv().args).toEqual(['-g', 'com.apple.system.thermalpressurelevel']);
  expect(lsofListenArgv(8001)!.args).toEqual(['-nP', '-iTCP:8001', '-sTCP:LISTEN', '-t']);
  expect(footprintArgv(4242)!.args).toEqual(['--noCategories', '-f', 'bytes', '-p', '4242']);
  expect(macmonArgv('/opt/homebrew/bin/macmon')!.args).toEqual(['pipe', '-i', '1000']);
  expect(lmsArgv(LMS, 'ps', 41_343, INFO)).toEqual({ file: LMS, args: ['ps', '--json', '--port', '41343'], timeoutMs: 5_000,
    maxBytes: 262_144, env: { LMS_API_SERVER_INFO_PATH: INFO } });
  for (const port of [0, -1, 65_536, 1.5, NaN]) expect(lsofListenArgv(port)).toBeNull();
  for (const pid of [0, 1, -4, 4_194_304, 2.5, NaN]) expect(footprintArgv(pid)).toBeNull();
  expect(macmonArgv('/usr/bin/macmon')).toBeNull();
  expect(lmsArgv('lms', 'ps', 41_343, INFO)).toBeNull();
  expect(lmsArgv(LMS, 'ps', 41_343, 'http-server.json')).toBeNull();
  for (const argv of every()) expect(argv.file.startsWith('/')).toBe(true);
  expect(Object.values(EXEC_PATHS).length + LMS_HOME_PATHS.length + MACMON_PATHS.length).toBe(10);   // the G1 freeze
});

test('allowed accepts exactly what the builders produce', () => {
  for (const argv of every()) expect(allowed(argv, HOME), JSON.stringify(argv)).toBe(true);
  // Copies with no shared references, as a caller or a mutation would pass them.
  for (const argv of every()) expect(allowed(JSON.parse(JSON.stringify(argv)) as Argv, HOME)).toBe(true);
});

test('allowed refuses every variation: extra, missing or reordered args, other files, limits, env or HOME', () => {
  const variants = (argv: Argv): Argv[] => [
    { ...argv, args: [...argv.args, '-x'] }, { ...argv, args: argv.args.slice(1) }, { ...argv, args: [...argv.args].reverse() },
    { ...argv, file: argv.file.replace(/^\//, '') }, { ...argv, file: `${argv.file}/../${argv.file.split('/').at(-1)}` },
    { ...argv, file: `/tmp${argv.file}` }, { ...argv, timeoutMs: argv.timeoutMs + 1 }, { ...argv, maxBytes: argv.maxBytes * 2 },
    { ...argv, env: { ...argv.env, NODE_OPTIONS: '--inspect' } }, { ...argv, args: argv.args.map(arg => `${arg};`) },
  ];
  for (const argv of every()) for (const variant of variants(argv)) {
    if (variant.args.length === argv.args.length && variant.args.every((arg, i) => arg === argv.args[i]) && variant.file === argv.file
      && variant.timeoutMs === argv.timeoutMs && variant.maxBytes === argv.maxBytes && variant.env === argv.env) continue;
    expect(allowed(variant, HOME), JSON.stringify(variant)).toBe(false);
  }
  const lsof = lsofListenArgv(8001)!, footprint = footprintArgv(4242)!;
  for (const arg of ['-iTCP:08001', '-iTCP:+8001', '-iTCP:8001.0', '-iTCP:0', '-iTCP:70000', '-iTCP:8001,8002', '-iTCP:*', '-iUDP:8001']) {
    expect(allowed({ ...lsof, args: ['-nP', arg, '-sTCP:LISTEN', '-t'] }, HOME), arg).toBe(false);
  }
  for (const pid of ['04242', '1', '0', '-1', '4242 ', '4e3', '4194304', 'self']) {
    expect(allowed({ ...footprint, args: [...footprint.args.slice(0, -1), pid] }, HOME), pid).toBe(false);
  }
  expect(allowed({ ...footprint, args: ['-p', '4242'] }, HOME)).toBe(false);                 // only the exact-bytes form
  expect(allowed({ file: '/bin/ps', args: ['-o', 'lstart=', '-p', '4242'], timeoutMs: 1_500, maxBytes: 4_096 }, HOME)).toBe(false);
  expect(allowed({ file: '/usr/bin/pmset', args: ['-g', 'therm'], timeoutMs: 1_500, maxBytes: 4_096 }, HOME)).toBe(false);
  expect(allowed({ file: '/bin/sh', args: ['-c', '/usr/bin/vm_stat'], timeoutMs: 1_500, maxBytes: 65_536 }, HOME)).toBe(false);
  expect(allowed({ ...vmStatArgv(), env: {} }, HOME)).toBe(true);                             // an empty env is no env
  expect(allowed({ ...vmStatArgv(), env: { LMS_API_SERVER_INFO_PATH: INFO } }, HOME)).toBe(false);
});

test('lms needs HOME, the server-info env and --port; it never runs from another HOME or with a foreign info path', () => {
  const ps = lmsArgv(LMS, 'ps', 41_343, INFO)!;
  expect(allowed(ps, HOME)).toBe(true);
  expect(allowed(ps, '/Users/fixture')).toBe(false);
  expect(allowed(ps, 'relative/home')).toBe(false);
  expect(allowed({ ...ps, env: undefined }, HOME)).toBe(false);
  expect(allowed({ ...ps, args: ['ps', '--json'] }, HOME)).toBe(false);
  expect(allowed({ ...ps, args: ['ps', '--json', '--port', '1234', '--port', '41343'] }, HOME)).toBe(false);
  for (const info of ['/etc/passwd', `${HOME}/.lmstudio/.internal/../.internal/http-server.json`, `${HOME}/.lmstudio/.internal/http-server.json.bak`,
    '.lmstudio/.internal/http-server.json', '']) {
    expect(allowed({ ...ps, env: { LMS_API_SERVER_INFO_PATH: info } }, HOME), info).toBe(false);
  }
  expect(allowed({ ...ps, env: { LMS_API_SERVER_INFO_PATH: `${HOME}/.cache/lm-studio/.internal/http-server.json` } }, HOME)).toBe(true);
  for (const args of [['server', 'start'], ['load', 'x'], ['unload', '--all'], ['log', 'stream', '--source', 'model', '--json']]) {
    expect(allowed({ ...ps, args: [...args, '--port', '41343'] }, HOME), args.join(' ')).toBe(false);
  }
});

test('createExec reads only allowlisted, env-free argv through readCommand', async () => {
  const calls: Array<[string, readonly string[], number, number]> = [];
  const exec = createExec(HOME, async (file, args, timeoutMs, maxBytes) => { calls.push([file, args, timeoutMs, maxBytes]); return 'ok'; });
  expect(await exec(vmStatArgv())).toBe('ok');
  expect(await exec(footprintArgv(4242)!)).toBe('ok');
  expect(calls).toEqual([['/usr/bin/vm_stat', [], 1_500, 65_536], ['/usr/bin/footprint', ['--noCategories', '-f', 'bytes', '-p', '4242'], 3_000, 65_536]]);
  expect(await exec({ ...vmStatArgv(), args: ['-c', '1'] })).toBeNull();
  expect(await exec(lmsArgv(LMS, 'ps', 41_343, INFO)!)).toBeNull();                          // env argv: the LM Studio spawner's job
  expect(await exec({ file: '/bin/echo', args: [], timeoutMs: 1_500, maxBytes: 64 })).toBeNull();
  expect(calls).toHaveLength(2);
  expect(await createExec(HOME, async () => { throw new Error('spawn failed'); })(vmStatArgv())).toBeNull();
});

test('createStreamSpawn spawns only allowlisted argv, without a shell, with stderr discarded', () => {
  const spawned: Array<{ file: string; args: string[]; options: unknown }> = [];
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: null, stdin: null }) as unknown as StreamChild;
  const spawn = createStreamSpawn(HOME, (file, args, options) => { spawned.push({ file, args, options }); return child; });
  expect(spawn(macmonArgv('/opt/homebrew/bin/macmon')!)).toBe(child);
  expect(spawn({ ...macmonArgv('/opt/homebrew/bin/macmon')!, args: ['pipe', '-i', '10'] })).toBeNull();
  expect(spawn({ file: '/usr/bin/yes', args: [], timeoutMs: 1, maxBytes: 1 })).toBeNull();
  expect(spawned).toEqual([{ file: '/opt/homebrew/bin/macmon', args: ['pipe', '-i', '1000'],
    options: { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { LANG: 'C', LC_ALL: 'C' } } }]);
  expect(createStreamSpawn(HOME, () => { throw new Error('ENOENT'); })(macmonArgv('/usr/local/bin/macmon')!)).toBeNull();
});

// P1: every child the service starts goes through the allowlist. Only argv.ts and native-command.ts (reached only from
// argv.ts) may spawn. The 1.6 files below still spawn directly and are named so their owners' rewrites retire them.
test('every spawn in the service goes through the argv allowlist', () => {
  const root = new URL('../', import.meta.url).pathname;
  const sources = [...new Glob('**/*.ts').scanSync(root)].filter(file => !file.endsWith('.test.ts')).sort();
  const LEGACY: Record<string, string> = {
    'lmstudio-activity.ts': 'ad-lmstudio: service/adapters/lmstudio-activity.ts replaces it',
    'mac-memory.ts': 'svc-host: service/host/memory.ts replaces it; off the production path (main.ts uses HostSampler)',
  };
  const spawning = sources.filter(file => /from 'node:child_process'|require\(['"]node:child_process/.test(readFileSync(`${root}${file}`, 'utf8')));
  expect(spawning.filter(file => !(file in LEGACY))).toEqual(['lib/argv.ts', 'native-command.ts']);
  const readers = sources.filter(file => /from '\.{1,2}\/(?:\.\.\/)*native-command\.ts'/.test(readFileSync(`${root}${file}`, 'utf8')));
  expect(readers.filter(file => !(file in LEGACY))).toEqual(['lib/argv.ts']);
  // The production entry never reaches the legacy host reader.
  const graph = new Set<string>(), queue = ['main.ts'];
  while (queue.length) {
    const file = queue.pop()!;
    if (graph.has(file)) continue;
    graph.add(file);
    for (const [, target] of readFileSync(`${root}${file}`, 'utf8').matchAll(/^import (?!type )[^;]*? from '(\.[^']+\.ts)';$/gm)) {
      const resolved = new URL(target!, `file://${root}${file}`).pathname;
      if (resolved.startsWith(root)) queue.push(resolved.slice(root.length));
    }
  }
  expect(graph.has('host/sampler.ts')).toBe(true);
  expect(graph.has('mac-memory.ts')).toBe(false);
  expect(graph.has('system.ts')).toBe(false);
});
