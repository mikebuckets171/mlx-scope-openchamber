import { expect, jest, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { classAKeys } from '../../src/contract/guards.ts';
import { lmsArgv, type Argv } from '../lib/argv.ts';
import {
  createLmsCli, createLmsExec, engineName, findLms, LMS_PS_EVERY_MS, LMS_PS_MIN_MS, LMS_RUNTIME_CACHE_MS, lmstudioHome, lmsModelName,
  parseLmsPs, parseRuntimeLs, readLmsPorts, serverInfoPathOf, type Spawn,
} from './lmstudio-cli.ts';

const FIXTURES = path.join(import.meta.dir, '../../tests/fixtures/lmstudio/bionic-1.1.6');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');
const INFO = '/Users/fixture/.lmstudio/.internal/http-server.json', LMS = '/Users/fixture/.lmstudio/bin/lms';
const LOADED = { model: 'publisher/example-27b-splash', source: 'lms-ps' as const, bytes: 18_683_107_738, contextWindowTokens: 262_144 };

test('lms ps --json: one row per instance with size and context; paths, devices and last-used times are never read', () => {
  expect(parseLmsPs(fixture('lms-ps-json.one-loaded.txt'))).toEqual([{ ...LOADED, phase: 'idle' as const }]);
  // A point-in-time "generating" is a busy phase with no prefill/decode split.
  expect(parseLmsPs(fixture('lms-ps-json.generating.txt'))).toEqual([{ ...LOADED, phase: 'processing' as const }]);
  expect(parseLmsPs(fixture('lms-ps-json.empty.txt'))).toEqual([]);
  const text = JSON.stringify([parseLmsPs(fixture('lms-ps-json.one-loaded.txt')), parseLmsPs(fixture('lms-ps-json.generating.txt'))]);
  for (const leak of ['Example-27B-Splash', '1790683105000', '1790683201000', 'deviceIdentifier', 'queued']) expect(text).not.toContain(leak);
  expect(classAKeys(JSON.parse(text))).toEqual([]);
});

test('lms ps --json: unknown keys and statuses, bad rows, path-like ids and the 12-row cap', () => {
  const record = JSON.parse(fixture('lms-ps-json.one-loaded.txt'))[0];
  // lms main appends engineConfigFileEnabled; an unknown status is not guessed.
  expect(parseLmsPs(JSON.stringify([{ ...record, engineConfigFileEnabled: true, status: 'warming' }]))).toEqual([{ ...LOADED, phase: 'unknown' as const }]);
  expect(parseLmsPs(JSON.stringify([{ ...record, identifier: '/Users/someone/models/private-model.gguf' }]))[0]!.model).toBe('private-model.gguf');
  expect(parseLmsPs(JSON.stringify([{ ...record, identifier: 7 }]))[0]!.model).toBe('publisher/example-27b-splash');
  expect(parseLmsPs(JSON.stringify([{ ...record, status: 'constructor', sizeBytes: -1, contextLength: 0 }]))).toEqual([
    { model: 'publisher/example-27b-splash', phase: 'unknown', source: 'lms-ps' }]);
  expect(parseLmsPs(JSON.stringify([null, 3, { identifier: '' }, {}]))).toEqual([]);
  for (const text of ['', 'No models are currently loaded', '{}', '{"identifier":"x"}', '[']) expect(parseLmsPs(text)).toEqual([]);
  expect(parseLmsPs(JSON.stringify(Array.from({ length: 20 }, (_, index) => ({ ...record, identifier: `example-${index}` }))))).toHaveLength(12);
});

test('lms runtime ls: selected engines first, short names, versions and model formats', () => {
  expect(parseRuntimeLs(fixture('lms-runtime-ls.bionic-splash.txt'))).toEqual([
    { name: 'llama.cpp', version: '2.41.0', selected: true, format: 'gguf' },
    { name: 'mlx-llm-nax', version: '1.9.0', selected: true, format: 'mlx' },
    { name: 'splash', version: '0.0.5', selected: true, format: 'yuzu' },
    { name: 'llama.cpp', version: '2.39.2', selected: false, format: 'gguf' },
    { name: 'mlx-llm', version: '1.9.0', selected: false, format: 'mlx' },
  ]);
  expect(engineName('splash-mac-arm64-apple-metal-advsimd')).toBe('splash');
  expect(engineName('mlx-llm-mac-arm64-apple-metal-nax-advsimd')).toBe('mlx-llm-nax');
  expect(engineName('llama.cpp-mac-arm64-apple-metal-advsimd')).toBe('llama.cpp');
  expect(engineName('executorch-asr')).toBe('executorch-asr');
});

test('lms runtime ls: anything that is not an engine row is ignored; rows are de-duplicated and capped at 8', () => {
  for (const text of ['', 'LLM ENGINE    SELECTED    MODEL FORMAT\n', 'Error: could not connect to LM Studio\n', 'x@y z\n', '@1.0    GGUF\n']) {
    expect(parseRuntimeLs(text)).toEqual([]);
  }
  const rows = Array.from({ length: 12 }, (_, index) => `engine${index}-mac-arm64-apple-metal-advsimd@1.${index}.0${index === 11 ? '    ✓' : ''}    GGUF`);
  const parsed = parseRuntimeLs(['LLM ENGINE    SELECTED    MODEL FORMAT', ...rows, rows[3]!, 'bad@version with space    MLX'].join('\n'));
  expect(parsed).toHaveLength(8);
  expect(parsed[0]).toEqual({ name: 'engine11', version: '1.11.0', selected: true, format: 'gguf' });
  expect(new Set(parsed.map(row => `${row.name}@${row.version}`)).size).toBe(8);
  expect(parseRuntimeLs('a-mac-arm64@1.0    ✓    Not A Format!\n')).toEqual([{ name: 'a', version: '1.0', selected: true }]);
});

test('model names from LM Studio keep only the last segment of a path or URL', () => {
  expect(lmsModelName('publisher/example-27b-splash')).toBe('publisher/example-27b-splash');
  expect(lmsModelName('/Users/someone/private/models/my-model.gguf')).toBe('my-model.gguf');
  expect(lmsModelName('~/models/qwen/')).toBe('qwen');
  expect(lmsModelName('file:///tmp/x/secret-model')).toBe('secret-model');
  expect(lmsModelName('https://example.invalid/a/b/model?token=x')).toBe('model');
  expect(lmsModelName('C:\\models\\m.gguf')).toBe('m.gguf');
  for (const value of ['', '   ', '\u0000', 3, null]) expect(lmsModelName(value)).toBeNull();
  expect(lmsModelName('m'.repeat(400))).toHaveLength(160);
});

/** A temporary HOME with an LM Studio home whose running app recorded `internal` and serves REST on `rest`. */
const fixtureHome = (options: { internal?: number | null; rest?: number | null; studio?: string; pointer?: boolean; lms?: string[] } = {}) => {
  const home = mkdtempSync(path.join(tmpdir(), 'scope-lms-'));
  const studio = path.join(home, options.studio ?? '.lmstudio');
  mkdirSync(path.join(studio, '.internal'), { recursive: true });
  if (options.internal !== null) writeFileSync(path.join(studio, '.internal', 'http-server.json'), JSON.stringify({ host: '127.0.0.1', pid: 1, port: options.internal ?? 41_343 }));
  if (options.rest !== null) writeFileSync(path.join(studio, '.internal', 'http-server-config.json'), JSON.stringify({ port: options.rest ?? 1234 }));
  if (options.pointer) writeFileSync(path.join(home, '.lmstudio-home-pointer'), `${studio}\n`);
  for (const relative of options.lms ?? []) { mkdirSync(path.dirname(path.join(home, relative)), { recursive: true }); writeFileSync(path.join(home, relative), ''); }
  return { home, studio };
};

test('the LM Studio home resolves like lms; only the two manifest lms paths are ever candidates', () => {
  const standard = fixtureHome({ lms: ['.lmstudio/bin/lms'] });
  expect(lmstudioHome(standard.home)).toBe(standard.studio);
  expect(findLms(standard.home)).toBe(path.join(standard.home, '.lmstudio', 'bin', 'lms'));
  expect(serverInfoPathOf(standard.home)).toBe(path.join(standard.studio, '.internal', 'http-server.json'));
  expect(readLmsPorts(serverInfoPathOf(standard.home))).toEqual({ internal: 41_343, rest: 1234 });
  const legacy = fixtureHome({ studio: path.join('.cache', 'lm-studio'), lms: ['.cache/lm-studio/bin/lms'] });
  expect(lmstudioHome(legacy.home)).toBe(legacy.studio);
  expect(findLms(legacy.home)).toBe(path.join(legacy.home, '.cache', 'lm-studio', 'bin', 'lms'));
  // A pointer moves the home (and so the server-info path), but its own bin/lms is not an allowlisted exec.
  const pointed = fixtureHome({ studio: 'elsewhere', pointer: true, lms: ['elsewhere/bin/lms'] });
  expect(lmstudioHome(pointed.home)).toBe(pointed.studio);
  expect(findLms(pointed.home)).toBeNull();
  expect(readLmsPorts(serverInfoPathOf(fixtureHome({ internal: null, rest: null }).home))).toEqual({ internal: null, rest: null });
  const bad = fixtureHome();
  writeFileSync(path.join(bad.studio, '.internal', 'http-server.json'), '{"port":0}');
  writeFileSync(path.join(bad.studio, '.internal', 'http-server-config.json'), 'not json');
  expect(readLmsPorts(serverInfoPathOf(bad.home))).toEqual({ internal: null, rest: null });
});

const recordExec = (reply: (argv: Argv) => string | null) => {
  const calls: Argv[] = [];
  return { calls, exec: async (argv: Argv) => { calls.push(argv); return reply(argv); } };
};

test('lms ps: on a generation change, every 180 s, never within 60 s, with the no-wake argv', async () => {
  let now = 1_000_000;
  const { calls, exec } = recordExec(() => fixture('lms-ps-json.one-loaded.txt'));
  const cli = createLmsCli({ exec, lms: LMS, serverInfoPath: INFO, now: () => now });
  expect(await cli.ps(41_343, 1)).toEqual([{ ...LOADED, phase: 'idle' as const }]);
  expect(calls).toEqual([lmsArgv(LMS, 'ps', 41_343, INFO)!]);
  expect(calls[0]).toMatchObject({ args: ['ps', '--json', '--port', '41343'], env: { LMS_API_SERVER_INFO_PATH: INFO } });
  now += 30_000;
  expect(await cli.ps(41_343, 1)).toHaveLength(1);
  expect(await cli.ps(41_343, 2)).toHaveLength(1);                 // changed, but inside the 60 s floor
  expect(calls).toHaveLength(1);
  now += LMS_PS_MIN_MS - 30_000;
  await cli.ps(41_343, 2);
  expect(calls).toHaveLength(2);
  now += LMS_PS_EVERY_MS - 1;
  await cli.ps(41_343, 2);
  expect(calls).toHaveLength(2);
  now += 1;
  await cli.ps(41_343, 2);
  expect(calls).toHaveLength(3);
});

test('lms ps: a failed or unparseable run keeps the last rows and is retried at the 60 s floor', async () => {
  let now = 0, reply: string | null = fixture('lms-ps-json.one-loaded.txt');
  const { calls, exec } = recordExec(() => reply);
  const cli = createLmsCli({ exec, lms: LMS, serverInfoPath: INFO, now: () => now });
  await cli.ps(41_343, 1);
  now += LMS_PS_EVERY_MS;
  reply = null;
  expect(await cli.ps(41_343, 1)).toHaveLength(1);
  now += LMS_PS_MIN_MS - 1;
  await cli.ps(41_343, 1);
  expect(calls).toHaveLength(2);
  now += 1;
  reply = 'Error: LM Studio is not running';
  expect(await cli.ps(41_343, 1)).toHaveLength(1);
  expect(calls).toHaveLength(3);
  now += LMS_PS_MIN_MS;
  reply = fixture('lms-ps-json.empty.txt');
  expect(await cli.ps(41_343, 1)).toEqual([]);
  expect(calls).toHaveLength(4);
});

test('lms ps: another internal port waits for the floor and never reports the old app instance', async () => {
  let now = 0;
  const { calls, exec } = recordExec(() => fixture('lms-ps-json.one-loaded.txt'));
  const cli = createLmsCli({ exec, lms: LMS, serverInfoPath: INFO, now: () => now });
  await cli.ps(41_343, 1);
  now += 10_000;
  expect(await cli.ps(50_123, 1)).toBeNull();
  now += LMS_PS_MIN_MS;
  expect(await cli.ps(50_123, 1)).toHaveLength(1);
  expect(calls.map(argv => argv.args.at(-1))).toEqual(['41343', '50123']);
});

test('lms ps and runtime ls: concurrent callers share one spawn; no lms or a bad port spawns nothing', async () => {
  let release: (text: string) => void = () => {};
  const calls: Argv[] = [];
  const exec = (argv: Argv) => { calls.push(argv); return new Promise<string | null>(resolve => { release = resolve; }); };
  const cli = createLmsCli({ exec, lms: LMS, serverInfoPath: INFO, now: () => 0 });
  const both = Promise.all([cli.ps(41_343, 1), cli.ps(41_343, 2)]);
  release(fixture('lms-ps-json.one-loaded.txt'));
  expect((await both).map(rows => rows?.length)).toEqual([1, 1]);
  expect(calls).toHaveLength(1);
  const none = recordExec(() => '[]');
  const absent = createLmsCli({ exec: none.exec, lms: null, serverInfoPath: INFO, now: () => 0 });
  expect([await absent.ps(41_343, 1), await absent.runtimeLs(41_343)]).toEqual([null, null]);
  const relative = createLmsCli({ exec: none.exec, lms: 'lms', serverInfoPath: INFO, now: () => 0 });
  expect([await relative.ps(41_343, 1), await relative.runtimeLs(41_343)]).toEqual([null, null]);
  const bound = createLmsCli({ exec: none.exec, lms: LMS, serverInfoPath: INFO, now: () => 0 });
  for (const port of [0, -1, 65_536, 1.5, Number.NaN]) expect([await bound.ps(port, 1), await bound.runtimeLs(port)]).toEqual([null, null]);
  expect(none.calls).toEqual([]);
});

test('lms runtime ls: cached 10 min per port; a failure is retried after 60 s', async () => {
  let now = 0, reply: string | null = fixture('lms-runtime-ls.bionic-splash.txt');
  const { calls, exec } = recordExec(() => reply);
  const cli = createLmsCli({ exec, lms: LMS, serverInfoPath: INFO, now: () => now });
  expect(await cli.runtimeLs(41_343)).toHaveLength(5);
  expect(calls).toEqual([lmsArgv(LMS, 'runtime-ls', 41_343, INFO)!]);
  now += LMS_RUNTIME_CACHE_MS - 1;
  await cli.runtimeLs(41_343);
  expect(calls).toHaveLength(1);
  now += 1;
  reply = null;
  expect(await cli.runtimeLs(41_343)).toHaveLength(5);             // the last good table stays until one replaces it
  now += LMS_PS_MIN_MS - 1;
  await cli.runtimeLs(41_343);
  expect(calls).toHaveLength(2);
  now += 1;
  reply = 'Error: unexpected output';
  await cli.runtimeLs(41_343);
  expect(calls).toHaveLength(3);
  expect(await cli.runtimeLs(50_123)).toBeNull();                  // another app instance is never served the old table
  expect(calls).toHaveLength(4);
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  killed: string[] = [];
  kill(signal: string) { this.killed.push(signal); return true; }
}

test('the one-shot spawner: timeout and oversize output kill the child and read as null', async () => {
  const home = '/Users/fixture', lms = path.join(home, '.lmstudio', 'bin', 'lms'), children: FakeChild[] = [];
  const spawnImpl = (() => { const child = new FakeChild(); children.push(child); return child; }) as unknown as Spawn;
  const exec = createLmsExec(home, spawnImpl);
  jest.useFakeTimers();
  try {
    const slow = exec(lmsArgv(lms, 'ps', 41_343, INFO)!);
    jest.advanceTimersByTime(5_000);
    expect(await slow).toBeNull();
    expect(children[0]!.killed).toEqual(['SIGKILL']);
  } finally { jest.useRealTimers(); }
  const big = exec(lmsArgv(lms, 'runtime-ls', 41_343, INFO)!);
  children[1]!.stdout.write(Buffer.alloc(256 * 1024 + 1, 0x61));
  expect(await big).toBeNull();
  expect(children[1]!.killed).toEqual(['SIGKILL']);
  const failed = exec(lmsArgv(lms, 'ps', 41_343, INFO)!);
  children[2]!.stdout.write('[]\n');
  children[2]!.emit('close', 1);
  expect(await failed).toBeNull();
  const error = exec(lmsArgv(lms, 'ps', 41_343, INFO)!);
  children[3]!.emit('error', new Error('spawn ENOENT'));
  expect(await error).toBeNull();
  const thrown = createLmsExec(home, (() => { throw new Error('EACCES'); }) as unknown as Spawn);
  expect(await thrown(lmsArgv(lms, 'ps', 41_343, INFO)!)).toBeNull();
});

test('the real one-shot spawner runs only allowlisted lms argv, with only the minimal environment', async () => {
  const { home, studio } = fixtureHome();
  const bin = path.join(home, '.lmstudio', 'bin'), stub = path.join(bin, 'lms'), info = path.join(studio, '.internal', 'http-server.json');
  mkdirSync(bin, { recursive: true });
  writeFileSync(stub, '#!/bin/sh\nenv > "$(/usr/bin/dirname "$0")/env.txt"\necho "$@" > "$(/usr/bin/dirname "$0")/args.txt"\necho "[]"\n');
  chmodSync(stub, 0o755);
  const exec = createLmsExec(home);
  const valid = lmsArgv(stub, 'ps', 41_343, info)!;
  const refused: Argv[] = [
    { ...valid, env: undefined }, { ...valid, env: { ...valid.env, NODE_OPTIONS: '--inspect' } }, { ...valid, args: ['ps', '--json'] },
    { ...valid, args: ['load', 'x', '--port', '41343'] }, { ...valid, args: ['server', 'start', '--port', '41343'] },
    { ...valid, file: '/bin/sh', args: ['-c', 'true'] }, { ...valid, timeoutMs: 60_000 }, { ...valid, maxBytes: 1 << 30 },
    { ...valid, env: { LMS_API_SERVER_INFO_PATH: '/tmp/../etc/.internal/http-server.json' } },
    { ...valid, env: { LMS_API_SERVER_INFO_PATH: path.join(studio, 'http-server.json') } }, { ...valid, args: ['ps', '--json', '--port', '041343'] },
  ];
  for (const argv of refused) expect(await exec(argv)).toBeNull();
  expect(existsSync(path.join(bin, 'args.txt'))).toBe(false);
  const previous = process.env.OPENCHAMBER_SERVICE_TOKEN;
  process.env.OPENCHAMBER_SERVICE_TOKEN = 'canary-service-token';
  try {
    expect(await exec(valid)).toBe('[]\n');
  } finally {
    if (previous === undefined) delete process.env.OPENCHAMBER_SERVICE_TOKEN; else process.env.OPENCHAMBER_SERVICE_TOKEN = previous;
  }
  expect(readFileSync(path.join(bin, 'args.txt'), 'utf8').trim()).toBe('ps --json --port 41343');
  const env = readFileSync(path.join(bin, 'env.txt'), 'utf8');
  expect(env).toContain(`LMS_API_SERVER_INFO_PATH=${info}\n`);
  expect(env).toContain('PATH=/usr/bin:/bin\n');
  expect(env).not.toContain('canary-service-token');
  expect(env).not.toContain('OPENCHAMBER');
  writeFileSync(stub, '#!/bin/sh\nexit 3\n');
  expect(await exec(valid)).toBeNull();
});
