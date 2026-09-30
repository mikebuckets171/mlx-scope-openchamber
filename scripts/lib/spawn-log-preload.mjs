// Measurement-only preload (`node --import`), used by scripts/measure-overhead.mjs. It logs every child process the
// measured service starts and reports the service's own CPU time and RSS on SIGUSR2 and at exit. The log is a private
// temporary file outside the sandbox HOME; it holds executable basenames, argument counts, whether the executable
// lies under HOME, times and PIDs, and the receipt keeps none of the PIDs. It changes nothing the service does.
import cp from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

const log = process.env.MLX_SCOPE_MEASURE_LOG;
if (log) {
  const home = process.env.HOME;
  let next = 0;
  const write = record => { try { appendFileSync(log, `${JSON.stringify(record)}\n`); } catch {} };
  const usage = kind => {
    const { user, system } = process.cpuUsage();
    write({ kind, at: Date.now(), cpuMicros: user + system, rssBytes: process.memoryUsage.rss() });
  };
  const started = (method, file, args) => {
    const id = next += 1;
    const record = { kind: 'spawn', id, method, file: basename(String(file)), argc: Array.isArray(args) ? args.length : 0,
      underHome: Boolean(home) && String(file).startsWith(`${home}/`), at: Date.now() };
    return { id, record };
  };
  // exec() calls the exported execFile, and execFile, fork, execSync and execFileSync call module-local
  // spawn/spawnSync, so wrapping these six counts every child exactly once.
  for (const method of ['spawn', 'execFile', 'fork']) {
    const original = cp[method];
    cp[method] = function measuredChild(...call) {
      const { id, record } = started(method, method === 'fork' ? process.execPath : call[0], call[1]);
      const child = original.apply(this, call);
      write({ ...record, pid: child.pid ?? null });
      let ended = false;
      const end = extra => { if (!ended) { ended = true; write({ kind: 'exit', id, at: Date.now(), ...extra }); } };
      child.once('exit', (code, signal) => end({ code, signal }));
      child.once('error', () => end({ error: true }));
      return child;
    };
  }
  for (const method of ['spawnSync', 'execFileSync', 'execSync']) {
    const original = cp[method];
    cp[method] = function measuredSyncChild(...call) {
      const { id, record } = started(method, method === 'execSync' ? '/bin/sh' : call[0], call[1]);
      write({ ...record, pid: null });
      try { return original.apply(this, call); } finally { write({ kind: 'exit', id, at: Date.now() }); }
    };
  }
  syncBuiltinESMExports();
  write({ kind: 'start', at: Date.now(), pid: process.pid });
  process.on('SIGUSR2', () => usage('usage'));
  process.on('exit', () => usage('final'));
}
