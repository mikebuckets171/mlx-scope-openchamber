import { spawn, type ChildProcessByStdio, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { readCommand } from '../native-command.ts';

// Every exec Scope may run (G1 freeze, 10 entries): absolute paths, no shell, exact argv. Owner: svc-host.
// native-command.ts stays byte-identical and passes only {LANG, LC_ALL}; `env` here is for lms, whose one-shot and
// stream spawners live in the LM Studio adapter. `/bin/ps` is not in the freeze, so nothing here builds a ps argv.

export const EXEC_PATHS = {
  vmStat: '/usr/bin/vm_stat', sysctl: '/usr/sbin/sysctl', ioreg: '/usr/sbin/ioreg', notifyutil: '/usr/bin/notifyutil',
  lsof: '/usr/sbin/lsof', footprint: '/usr/bin/footprint',
} as const;
/** Under HOME; the manifest declares them as `~/…`. */
export const LMS_HOME_PATHS = ['.lmstudio/bin/lms', '.cache/lm-studio/bin/lms'] as const;
export const MACMON_PATHS = ['/opt/homebrew/bin/macmon', '/usr/local/bin/macmon'] as const;
export const SYSCTL_KEYS = ['vm.swapusage', 'kern.memorystatus_vm_pressure_level', 'iogpu.wired_limit_mb'] as const;
export const IOREG_MAX_BYTES = 128 * 1024;
/** One macmon NDJSON line; longer lines are dropped whole (BoundedLines). */
export const MACMON_LINE_BYTES = 16 * 1024;

export interface Argv {
  file: string;
  args: readonly string[];
  timeoutMs: number;
  maxBytes: number;
  env?: Readonly<Record<string, string>>;
}
/** Runs one allowlisted argv; null on absence, non-zero exit, timeout or oversize output. */
export type Exec = (argv: Argv) => Promise<string | null>;
export type LmsCommand = 'ps' | 'runtime-ls' | 'log-stream';

/** A loopback TCP port, 1–65535. */
export const loopbackPort = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65_536 ? value : null;
/** A process id, held in service memory only (never on the wire). */
export const processId = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 1 && value < 4_194_304 ? value : null;

export const vmStatArgv = (): Argv => ({ file: EXEC_PATHS.vmStat, args: [], timeoutMs: 1_500, maxBytes: 64 * 1024 });
export const sysctlArgv = (): Argv => ({ file: EXEC_PATHS.sysctl, args: ['-i', ...SYSCTL_KEYS], timeoutMs: 1_500, maxBytes: 64 * 1024 });
export const ioregArgv = (): Argv => ({ file: EXEC_PATHS.ioreg, args: ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], timeoutMs: 1_500, maxBytes: IOREG_MAX_BYTES });
export const notifyutilArgv = (): Argv => ({ file: EXEC_PATHS.notifyutil, args: ['-g', 'com.apple.system.thermalpressurelevel'], timeoutMs: 1_500, maxBytes: 4 * 1024 });
export const lsofListenArgv = (port: number): Argv | null => loopbackPort(port) === null ? null
  : { file: EXEC_PATHS.lsof, args: ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], timeoutMs: 1_500, maxBytes: 4 * 1024 };
/** Exact bytes (`-f bytes`): the formatted form rounds to whole GB. `--noCategories` skips the category table. */
export const footprintArgv = (pid: number): Argv | null => processId(pid) === null ? null
  : { file: EXEC_PATHS.footprint, args: ['--noCategories', '-f', 'bytes', '-p', String(pid)], timeoutMs: 3_000, maxBytes: 64 * 1024 };

/** `lms` always carries the no-wake env and an explicit port (Stage H); without them lms can launch LM Studio. */
export const lmsArgv = (lms: string, command: LmsCommand, port: number, serverInfoPath: string): Argv | null => {
  if (loopbackPort(port) === null || !path.isAbsolute(lms) || !path.isAbsolute(serverInfoPath)) return null;
  const args = command === 'ps' ? ['ps', '--json'] : command === 'runtime-ls' ? ['runtime', 'ls'] : ['log', 'stream', '-s', 'server', '--json'];
  return { file: lms, args: [...args, '--port', String(port)], timeoutMs: 5_000, maxBytes: 256 * 1024,
    env: { LMS_API_SERVER_INFO_PATH: serverInfoPath } };
};

// ── LM Studio · owned by ad-lmstudio ───────────────────────────────────────────────────────────────────────────────
// The lms half of the P1 oracle, kept apart so `allowed` below can delegate to it. An lms spawn is legal only as
// exactly what `lmsArgv` builds, for an allowlisted binary under HOME and an app's own `.internal/http-server.json`.
/** The allowlisted lms binaries for this HOME, in preference order. */
export const lmsPaths = (home: string): string[] => path.isAbsolute(home) ? LMS_HOME_PATHS.map(file => path.join(home, file)) : [];
const LMS_COMMANDS: readonly LmsCommand[] = ['ps', 'runtime-ls', 'log-stream'];
const argvKey = (argv: Argv): string => JSON.stringify([argv.file, argv.args, argv.env ?? null, argv.timeoutMs, argv.maxBytes]);
export const isLmsArgv = (argv: Argv, home: string): boolean => {
  const info = argv.env?.LMS_API_SERVER_INFO_PATH, port = loopbackPort(Number(argv.args.at(-1)));
  if (!lmsPaths(home).includes(argv.file) || port === null || typeof info !== 'string' || path.normalize(info) !== info
    || path.basename(info) !== 'http-server.json' || path.basename(path.dirname(info)) !== '.internal') return false;
  return LMS_COMMANDS.some(command => { const built = lmsArgv(argv.file, command, port, info); return built !== null && argvKey(built) === argvKey(argv); });
};
// ── end LM Studio ──────────────────────────────────────────────────────────────────────────────────────────────────

export const macmonArgv = (macmon: string): Argv | null => (MACMON_PATHS as readonly string[]).includes(macmon)
  ? { file: macmon, args: ['pipe', '-i', '1000'], timeoutMs: 60_000, maxBytes: MACMON_LINE_BYTES } : null;

/** Canonical decimal only: no sign, no leading zero, no exponent, so `String(n)` round-trips. */
const decimal = (value: string | undefined): number => value !== undefined && /^[1-9]\d{0,6}$/.test(value) ? Number(value) : 0;
const sameEnv = (a: Argv['env'], b: Argv['env']): boolean => {
  const left = Object.entries(a ?? {}), right = b ?? {};
  return left.length === Object.keys(right).length && left.every(([key, value]) => Object.hasOwn(right, key) && right[key] === value);
};
const same = (argv: Argv, built: Argv | null): boolean => built !== null && argv.file === built.file
  && argv.timeoutMs === built.timeoutMs && argv.maxBytes === built.maxBytes && argv.args.length === built.args.length
  && argv.args.every((arg, index) => arg === built.args[index]) && sameEnv(argv.env, built.env);
/** The server-info file lms reads (`<LM Studio home>/.internal/http-server.json`), never anything else. */
const serverInfo = (value: unknown): string => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value
  && value.endsWith(`${path.sep}.internal${path.sep}http-server.json`) ? value : '';

/** The P1 allowlist: exactly the argv the builders above produce, for this HOME. Tests and every exec wrapper use it. */
export const allowed = (argv: Argv, home: string): boolean => {
  if (!argv || typeof argv.file !== 'string' || !Array.isArray(argv.args) || argv.args.some(arg => typeof arg !== 'string')) return false;
  const { file, args } = argv;
  switch (file) {
    case EXEC_PATHS.vmStat: return same(argv, vmStatArgv());
    case EXEC_PATHS.sysctl: return same(argv, sysctlArgv());
    case EXEC_PATHS.ioreg: return same(argv, ioregArgv());
    case EXEC_PATHS.notifyutil: return same(argv, notifyutilArgv());
    case EXEC_PATHS.lsof: return same(argv, lsofListenArgv(decimal(/^-iTCP:(\d+)$/.exec(args[1] ?? '')?.[1])));
    case EXEC_PATHS.footprint: return same(argv, footprintArgv(decimal(args.at(-1))));
  }
  if ((MACMON_PATHS as readonly string[]).includes(file)) return same(argv, macmonArgv(file));
  const lms = path.isAbsolute(home) && LMS_HOME_PATHS.some(relative => path.join(home, relative) === file);
  const commands: LmsCommand[] = ['ps', 'runtime-ls', 'log-stream'];
  return lms && commands.some(command => same(argv, lmsArgv(file, command, decimal(args.at(-1)), serverInfo(argv.env?.LMS_API_SERVER_INFO_PATH))));
};

type ReadCommand = (file: string, args: readonly string[], timeoutMs: number, maxBytes: number) => Promise<string | null>;
/**
 * The one-shot gate every host probe goes through: an allowlisted argv without `env` reaches `readCommand`; anything
 * else never spawns. An `env` argv (lms) belongs to the LM Studio adapter's own spawner, which checks `allowed` too.
 */
export const createExec = (home: string, read: ReadCommand = readCommand): Exec => async argv => {
  if (argv.env !== undefined || !allowed(argv, home)) return null;
  try { return await read(argv.file, argv.args, argv.timeoutMs, argv.maxBytes); } catch { return null; }
};

export type StreamChild = ChildProcessByStdio<null, Readable, null>;
export type StreamSpawn = (argv: Argv) => StreamChild | null;
type Spawner = (file: string, args: string[], options: SpawnOptions & { stdio: ['ignore', 'pipe', 'ignore'] }) => StreamChild;
/**
 * The streaming gate (macmon): allowlisted argv only, no shell, stdout piped, stderr discarded so it can never fill a
 * pipe. The child gets `{LANG, LC_ALL}` plus the argv's own `env`.
 */
export const createStreamSpawn = (home: string, spawnStream: Spawner = spawn as unknown as Spawner): StreamSpawn => argv => {
  if (!allowed(argv, home)) return null;
  try {
    return spawnStream(argv.file, [...argv.args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { LANG: 'C', LC_ALL: 'C', ...argv.env } });
  } catch { return null; }
};
