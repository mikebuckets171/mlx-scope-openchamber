import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { defined, label, list, opt } from '../../src/contract/guards.ts';
import { LIMITS, type EngineV2, type Phase, type ResidencyV2 } from '../../src/contract/snapshot.ts';
import { isLmsArgv, lmsArgv, lmsPaths, loopbackPort, type Argv, type Exec } from '../lib/argv.ts';
import { obj, positive } from '../lib/parse.ts';

// Owner: ad-lmstudio. One-shot `lms ps --json` / `lms runtime ls` with the no-wake env and --port (service/lib/argv.ts
// lmsArgv). native-command.ts cannot pass env, so the one-shot spawner lives here. Cadence: ps on a generation change,
// else 180 s, full tier only, never under 60 s; runtime ls only with detail=server, cached 10 min.

export const LMS_PS_MIN_MS = 60_000;
export const LMS_PS_EVERY_MS = 180_000;
export const LMS_RUNTIME_CACHE_MS = 600_000;

/** Small local JSON files only; anything missing, oversized or malformed reads as absent. Nothing is ever written. */
const readSmall = (file: string, limit = 64 * 1024): string | null => {
  try { return statSync(file).size <= limit ? readFileSync(file, 'utf8') : null; } catch { return null; }
};
const filePort = (file: string): number | null => {
  try { return loopbackPort(obj(JSON.parse(readSmall(file) ?? 'null'))?.port); } catch { return null; }
};
/** The LM Studio home, resolved the way lms resolves it: the home pointer, then the legacy cache home, then ~/.lmstudio. */
export const lmstudioHome = (home = homedir()): string => {
  const pointer = readSmall(path.join(home, '.lmstudio-home-pointer'), 4096)?.trim();
  if (pointer && path.isAbsolute(pointer)) return pointer;
  const legacy = path.join(home, '.cache', 'lm-studio');
  return existsSync(legacy) ? legacy : path.join(home, '.lmstudio');
};
/** The first allowlisted lms under HOME. A pointer-moved home's own bin/lms is not in the manifest, so it is never run. */
export const findLms = (home = homedir()): string | null => lmsPaths(home).find(file => existsSync(file)) ?? null;
/** Where the running app records its internal (lms) port; absent or portless while LM Studio or Bionic is not running. */
export const serverInfoPathOf = (home = homedir()): string => path.join(lmstudioHome(home), '.internal', 'http-server.json');
export interface LmsPorts { internal: number | null; rest: number | null }
/** The app's recorded ports: `internal` serves lms, `rest` is the REST server a connection points at. */
export const readLmsPorts = (serverInfoPath: string): LmsPorts => ({
  internal: filePort(serverInfoPath), rest: filePort(path.join(path.dirname(serverInfoPath), 'http-server-config.json')),
});

/** The whole environment of an lms child: locale, HOME, a fixed PATH and the argv's no-wake server-info path. */
export const lmsEnv = (argv: Argv, home: string): NodeJS.ProcessEnv =>
  ({ LANG: 'C', LC_ALL: 'C', HOME: home, PATH: '/usr/bin:/bin', ...argv.env });
/** LM Studio also reports model URLs and paths: those keep only their last segment, so no path leaves the service. */
export const lmsModelName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  let name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (/^(?:[\\/]|\.{1,2}[\\/]|[a-z]:[\\/]|~[\\/]|file:|[a-z][a-z0-9+.-]*:\/\/)/i.test(name)) {
    name = name.replace(/[?#].*$/, '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').at(-1) ?? '';
  }
  return name ? name.slice(0, 160) : null;
};

export type Spawn = (file: string, args: string[], options: SpawnOptions) => ChildProcess;
const nodeSpawn: Spawn = (file, args, options) => spawn(file, args, options);
/**
 * The bounded one-shot spawner for lms: nothing runs unless `isLmsArgv` accepts the argv for this HOME. Null on a
 * refused argv, a spawn error, a non-zero exit, the timeout or output past `maxBytes` (the child is killed).
 */
export const createLmsExec = (home = homedir(), spawnImpl: Spawn = nodeSpawn): Exec => argv => new Promise(resolve => {
  if (!isLmsArgv(argv, home)) { resolve(null); return; }
  let child: ChildProcess;
  try {
    child = spawnImpl(argv.file, [...argv.args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: lmsEnv(argv, home) });
  } catch { resolve(null); return; }
  const chunks: Buffer[] = [];
  let size = 0, settled = false;
  const kill = () => { try { child.kill('SIGKILL'); } catch { /* Already exited. */ } };
  const settle = (value: string | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
  const timer = setTimeout(() => { kill(); settle(null); }, argv.timeoutMs);
  timer.unref?.();
  child.stdout?.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > argv.maxBytes) { kill(); settle(null); } else chunks.push(chunk);
  });
  child.once('error', () => settle(null));
  child.once('close', code => settle(code === 0 && size <= argv.maxBytes ? Buffer.concat(chunks).toString('utf8') : null));
});

/** `lms ps --json` stdout, or null when it is not a JSON array (an error text is not "nothing loaded"). */
const psRecords = (text: string): unknown[] | null => {
  try { const value: unknown = JSON.parse(text); return Array.isArray(value) ? value : null; } catch { return null; }
};
// A point-in-time status: the adapter shows it as a live phase only through the log stream, never from a 3 min old ps.
const PS_PHASES: ReadonlyMap<unknown, Phase> = new Map([['idle', 'idle'], ['generating', 'processing'], ['loading', 'loading']]);
/**
 * One row per loaded instance. Only the instance id, status, size and context are read; `path`,
 * `indexedModelIdentifier`, `deviceIdentifier` and `lastUsedTime` never are. Unknown keys are ignored.
 */
export const parseLmsPs = (text: string): ResidencyV2[] => list(psRecords(text) ?? [], LIMITS.residency, raw => {
  const item = obj(raw), model = lmsModelName(item?.identifier) ?? lmsModelName(item?.modelKey);
  return item && model ? defined({ model, phase: PS_PHASES.get(item.status) ?? 'unknown', source: 'lms-ps' as const,
    bytes: opt(positive(item.sizeBytes)), contextWindowTokens: opt(positive(item.contextLength)) }) : null;
});

const PLATFORM = new Set(['mac', 'arm64', 'x64', 'apple', 'metal', 'advsimd', 'avx', 'avx2', 'cpu']);
/** `splash-mac-arm64-apple-metal-advsimd` → `splash`; a non-default build keeps its marker (`mlx-llm-…-nax-…` → `mlx-llm-nax`). */
export const engineName = (full: string): string => {
  const at = full.indexOf('-mac-');
  return at <= 0 ? full : [full.slice(0, at), ...full.slice(at + 1).split('-').filter(token => !PLATFORM.has(token))].join('-');
};
const ENGINE = /^([A-Za-z0-9][A-Za-z0-9._-]*)@([0-9A-Za-z][0-9A-Za-z._+-]{0,39})$/;
const FORMAT = /^[a-z0-9._-]{1,16}$/;
/**
 * The `lms runtime ls` table (columnify, 4-space splitter): `name@version`, ✓ when it is the engine selected for its
 * model format, then the format. Rows are matched by shape, not column offsets; selected engines first, ≤ 8.
 */
export const parseRuntimeLs = (text: string): EngineV2[] => {
  const rows = text.split('\n').flatMap(line => {
    const [first, ...rest] = line.trim().split(/\s{2,}/), match = ENGINE.exec(first ?? ''), name = label(match && engineName(match[1]!), 40);
    if (!match || !name) return [];
    const format = rest.filter(cell => cell !== '✓').at(-1)?.toLowerCase();
    return [defined({ name, version: match[2]!, selected: rest.includes('✓'), format: format && FORMAT.test(format) ? format : undefined })];
  });
  const seen = new Set<string>();
  return rows.sort((a, b) => Number(b.selected) - Number(a.selected))
    .filter(row => !seen.has(`${row.name}@${row.version}`) && seen.add(`${row.name}@${row.version}`)).slice(0, LIMITS.engines);
};

export interface LmsCli {
  ps(port: number, generation: number): Promise<ResidencyV2[] | null>;
  runtimeLs(port: number): Promise<EngineV2[] | null>;
}
interface Cached<T> { port: number; at: number; generation: number; failed: boolean; value: T | null }
/**
 * lms one-shots for the connection's internal port. The caller gates on the greeting and tier; this enforces the
 * spawn cadence: `ps` is due on a generation (or port) change, after a failure, or every 180 s, and never within
 * 60 s of the last attempt; `runtime ls` is cached 10 min (a failure is retried after 60 s). Concurrent calls share
 * one spawn. Null means unknown (no lms, a refused argv, a failed or unparseable run with nothing cached).
 */
export const createLmsCli = (options: { exec: Exec; lms: string | null; serverInfoPath: string; now: () => number }): LmsCli => {
  const { exec, lms, serverInfoPath, now } = options;
  let ps: Cached<ResidencyV2[]> | null = null, engines: Cached<EngineV2[]> | null = null;
  let psFlight: Promise<ResidencyV2[] | null> | null = null, enginesFlight: Promise<EngineV2[] | null> | null = null;
  const run = async (command: 'ps' | 'runtime-ls', port: number): Promise<string | null> => {
    const argv = lms === null ? null : lmsArgv(lms, command, port, serverInfoPath);
    return argv ? exec(argv) : null;
  };
  const kept = <T>(last: Cached<T> | null, port: number): T | null => last?.port === port ? last.value : null;
  return {
    ps(port, generation) {
      if (lms === null || loopbackPort(port) === null) return Promise.resolve(null);
      if (psFlight) return psFlight;
      const at = now(), last = ps, elapsed = last ? at - last.at : Infinity;
      const changed = last !== null && (last.port !== port || last.generation !== generation || last.failed);
      if (!(elapsed >= LMS_PS_EVERY_MS || elapsed < 0 || changed && elapsed >= LMS_PS_MIN_MS)) return Promise.resolve(kept(last, port));
      psFlight = run('ps', port).then(text => {
        const rows = text !== null && psRecords(text) !== null ? parseLmsPs(text) : null;
        // A failed run keeps the last good rows for this port; the adapter still drops any the REST inventory no longer lists.
        ps = { port, at, generation, failed: rows === null, value: rows ?? kept(last, port) };
        return ps.value;
      }).finally(() => { psFlight = null; });
      return psFlight;
    },
    runtimeLs(port) {
      if (lms === null || loopbackPort(port) === null) return Promise.resolve(null);
      if (enginesFlight) return enginesFlight;
      const at = now(), last = engines, elapsed = last ? at - last.at : Infinity;
      const fresh = last !== null && last.port === port && elapsed >= 0 && elapsed < (last.failed ? LMS_PS_MIN_MS : LMS_RUNTIME_CACHE_MS);
      if (fresh) return Promise.resolve(last.value);
      enginesFlight = run('runtime-ls', port).then(text => {
        const rows = text === null ? null : parseRuntimeLs(text);
        const failed = rows === null || rows.length === 0 && text!.trim() !== '';
        engines = { port, at, generation: 0, failed, value: failed ? kept(last, port) : rows };
        return engines.value;
      }).finally(() => { enginesFlight = null; });
      return enginesFlight;
    },
  };
};
