import path from 'node:path';

// Every exec Scope may run (G1 freeze, 10 entries): absolute paths, no shell, exact argv. Owner: svc-host.
// native-command.ts stays byte-identical and passes only {LANG, LC_ALL}; `env` here is for lms, whose one-shot and
// stream spawners live in the LM Studio adapter.

export const EXEC_PATHS = {
  vmStat: '/usr/bin/vm_stat', sysctl: '/usr/sbin/sysctl', ioreg: '/usr/sbin/ioreg', notifyutil: '/usr/bin/notifyutil',
  lsof: '/usr/sbin/lsof', footprint: '/usr/bin/footprint',
} as const;
/** Under HOME; the manifest declares them as `~/…`. */
export const LMS_HOME_PATHS = ['.lmstudio/bin/lms', '.cache/lm-studio/bin/lms'] as const;
export const MACMON_PATHS = ['/opt/homebrew/bin/macmon', '/usr/local/bin/macmon'] as const;
export const SYSCTL_KEYS = ['vm.swapusage', 'kern.memorystatus_vm_pressure_level', 'iogpu.wired_limit_mb'] as const;
export const IOREG_MAX_BYTES = 128 * 1024;

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
export const footprintArgv = (pid: number): Argv | null => processId(pid) === null ? null
  : { file: EXEC_PATHS.footprint, args: ['-p', String(pid)], timeoutMs: 3_000, maxBytes: 64 * 1024 };

/** `lms` always carries the no-wake env and an explicit port (Stage H); without them lms can launch LM Studio. */
export const lmsArgv = (lms: string, command: LmsCommand, port: number, serverInfoPath: string): Argv | null => {
  if (loopbackPort(port) === null || !path.isAbsolute(lms) || !path.isAbsolute(serverInfoPath)) return null;
  const args = command === 'ps' ? ['ps', '--json'] : command === 'runtime-ls' ? ['runtime', 'ls'] : ['log', 'stream', '-s', 'server', '--json'];
  return { file: lms, args: [...args, '--port', String(port)], timeoutMs: 5_000, maxBytes: 256 * 1024,
    env: { LMS_API_SERVER_INFO_PATH: serverInfoPath } };
};
export const macmonArgv = (macmon: string): Argv | null => (MACMON_PATHS as readonly string[]).includes(macmon)
  ? { file: macmon, args: ['pipe', '-i', '1000'], timeoutMs: 60_000, maxBytes: 16 * 1024 } : null;

/** The P1 allowlist: exactly the argv the builders above produce, for this HOME. Tests and every exec wrapper use it. */
export const allowed = (argv: Argv, home: string): boolean => {
  void argv; void home;
  throw new Error('argv allowlist: not implemented (svc-host)');
};
