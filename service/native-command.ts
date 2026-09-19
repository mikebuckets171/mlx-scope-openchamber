import { spawn, type ChildProcessByStdio, type SpawnOptions } from 'node:child_process';
import type { Readable } from 'node:stream';

type CommandProcess = ChildProcessByStdio<null, Readable, Readable>;
type CommandSpawner = (file: string, args: string[], options: SpawnOptions & {
  stdio: ['ignore', 'pipe', 'pipe'];
}) => CommandProcess;

/** Read fixed, read-only commands without a shell or an unused input pipe. */
export function readCommand(file: string, args: readonly string[], timeoutMs = 1_500,
  maxBytes = 64 * 1024, spawnCommand: CommandSpawner = spawn): Promise<string | null> {
  return new Promise(resolve => {
    let child: CommandProcess | undefined;
    let settled = false, exited = false, stdoutEnded = false, stderrEnded = false;
    let bytes = 0;
    let chunks: Buffer[] = [];
    const finish = (value: string | null, terminate = false) => {
      if (settled) return;
      settled = true; clearTimeout(timer); chunks = [];
      if (terminate && child) {
        // Only our own read-only child, never oMLX or OpenChamber.
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
        }
        child.stdout.destroy(); child.stderr.destroy();
      }
      resolve(value);
    };
    // An exit is not enough: all captured output must also have reached EOF.
    // Conversely, success must not depend on an unused stdin closing in the host runtime.
    const complete = () => {
      if (exited && stdoutEnded && stderrEnded) finish(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(() => finish(null, true), timeoutMs);
    try {
      child = spawnCommand(file, [...args], {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { LANG: 'C', LC_ALL: 'C' },
      });
      const receive = (chunk: Buffer, keep: boolean) => {
        if (settled) return;
        bytes += chunk.byteLength;
        if (bytes > maxBytes) { finish(null, true); return; }
        if (keep) chunks.push(chunk);
      };
      child.stdout.on('data', chunk => receive(chunk, true));
      child.stderr.on('data', chunk => receive(chunk, false));
      child.stdout.once('end', () => { stdoutEnded = true; complete(); });
      child.stderr.once('end', () => { stderrEnded = true; complete(); });
      child.stdout.once('close', () => { if (!stdoutEnded) finish(null, true); });
      child.stderr.once('close', () => { if (!stderrEnded) finish(null, true); });
      child.stdout.on('error', () => finish(null, true));
      child.stderr.on('error', () => finish(null, true));
      child.once('error', () => finish(null, true));
      child.once('exit', (code, signal) => {
        if (code !== 0 || signal !== null) { finish(null, true); return; }
        exited = true; complete();
      });
      child.once('close', (code, signal) => {
        if (code === 0 && signal === null && stdoutEnded && stderrEnded) {
          finish(Buffer.concat(chunks).toString('utf8'));
        } else { finish(null, true); }
      });
    } catch { finish(null, true); }
  });
}
