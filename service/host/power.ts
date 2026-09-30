import { accessSync, constants } from 'node:fs';
import { defined, obj, opt } from '../../src/contract/guards.ts';
import type { PowerV2 } from '../../src/contract/host.ts';
import { createStreamSpawn, MACMON_LINE_BYTES, MACMON_PATHS, macmonArgv, type StreamChild, type StreamSpawn } from '../lib/argv.ts';
import { BoundedLines } from '../lmstudio-activity.ts';

// Owner: svc-host. `macmon pipe -i 1000`, streamed with BoundedLines and a 60 s idle-stop; absent without macmon.
// Label (SPIKES S9): "Chip power (CPU+GPU+ANE, macmon estimate) · includes all apps · not wall power". Scope never installs it.

export const POWER_IDLE_STOP_MS = 60_000;
export const POWER_VIEW_WINDOW_MS = 10_000;
/** A newest line older than this means the stream stalled or stopped: no reading, not the last one. */
export const POWER_STALE_MS = 3_000;
export const POWER_MIN_COVERAGE = 0.8;
/** 15 min of 1 s lines: energy for replies up to that long. */
export const POWER_RING = 900;
const INTERVAL_MS = 1_000;                    // -i 1000: each line averages the second before it
const SILENT_EXIT_LIMIT = 5;

/** The first macmon Scope may run (MACMON_PATHS), or null; a stat, never a spawn. */
export const findMacmon = (access: (file: string, mode: number) => void = accessSync): string | null =>
  MACMON_PATHS.find(file => { try { access(file, constants.X_OK); return true; } catch { return false; } }) ?? null;

const watts = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 10_000 ? value : null;
/** One complete NDJSON line (v0.8 and v0.7 share the power fields). A cut or foreign line is null, never a partial parse. */
export const parseMacmonLine = (line: string, sampledAt: number): Omit<PowerV2, 'coverageFraction'> | null => {
  if (!line.startsWith('{') || !line.endsWith('}')) return null;
  let record: unknown;
  try { record = JSON.parse(line); } catch { return null; }
  const item = obj(record), chipW = watts(item?.all_power), sysW = watts(item?.sys_power);
  if (!item || chipW === null) return null;
  // macmon writes sys_power 0.0 when SMC key PSTR can't be read: zero is "not reported", not zero watts.
  return defined({ sampledAt, field: 'all_power' as const, chipW, cpuW: opt(watts(item.cpu_power)), gpuW: opt(watts(item.gpu_power)),
    aneW: opt(watts(item.ane_power)), sysW: sysW ? sysW : undefined });
};

export interface PowerStream {
  touch(): void;
  /** The newest sample with coverage over the last window; undefined without macmon or samples. */
  view(now: number): PowerV2 | undefined;
  /** Joules over [from, to] when coverage ≥ 0.8 (tok/J and CompletionV2.host.energyJ). */
  energy(from: number, to: number): { energyJ: number; coverage: number } | null;
  dispose(): void;
}
export interface PowerStreamOptions {
  macmon: string | null; now: () => number; spawn?: StreamSpawn; idleStopMs?: number; restartBaseMs?: number;
}
type Sample = Omit<PowerV2, 'coverageFraction'> & { from: number };

/** Each line covers the second before it, clipped at the previous line so late lines never count a moment twice. */
const covered = (samples: readonly Sample[], from: number, to: number): { ms: number; joules: number } => {
  let ms = 0, joules = 0;
  for (const sample of samples) {
    const overlap = Math.min(to, sample.sampledAt) - Math.max(from, sample.from);
    if (overlap > 0) { ms += overlap; joules += sample.chipW * overlap / 1000; }
  }
  return { ms, joules };
};

class MacmonStream implements PowerStream {
  private child: StreamChild | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private silentExits = 0;
  private samples: Sample[] = [];
  private readonly spawn: StreamSpawn;

  constructor(private readonly options: PowerStreamOptions) {
    this.spawn = options.spawn ?? createStreamSpawn('');
  }

  /** A full-tier read wants power: start the stream if needed and push the idle-stop back. */
  touch(): void {
    if (!this.options.macmon) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.options.idleStopMs ?? POWER_IDLE_STOP_MS);
    this.idleTimer.unref?.();
    if (!this.child && !this.restartTimer && this.silentExits < SILENT_EXIT_LIMIT) this.start();
  }

  view(now: number): PowerV2 | undefined {
    const newest = this.samples.at(-1);
    if (!newest || now - newest.sampledAt > POWER_STALE_MS || newest.sampledAt > now) return undefined;
    const { ms } = covered(this.samples, now - POWER_VIEW_WINDOW_MS, now);
    const { from: _from, ...sample } = newest;
    return { ...sample, coverageFraction: Math.min(1, ms / POWER_VIEW_WINDOW_MS) };
  }

  /** Scaled from the covered part (mean power × span), which is why it needs ≥ 80% coverage and stays an estimate. */
  energy(from: number, to: number): { energyJ: number; coverage: number } | null {
    if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) return null;
    const { ms, joules } = covered(this.samples, from, to), coverage = Math.min(1, ms / (to - from));
    return coverage >= POWER_MIN_COVERAGE ? { energyJ: joules / coverage, coverage } : null;
  }

  dispose(): void { this.stop(); this.samples = []; }

  private stop(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const child = this.child;
    this.child = null;
    this.failures = 0; this.silentExits = 0;
    if (child && child.exitCode === null && child.signalCode === null) { try { child.kill('SIGTERM'); } catch { /* Already exited. */ } }
  }

  private start(): void {
    const argv = macmonArgv(this.options.macmon!), child = argv && this.spawn(argv);
    if (!child) { this.silentExits = SILENT_EXIT_LIMIT; return; }
    this.child = child;
    let output = false;
    const lines = new BoundedLines(line => {
      const at = this.options.now(), sample = this.child === child ? parseMacmonLine(line, at) : null;
      if (!sample) return;
      output = true; this.failures = 0; this.silentExits = 0;
      const previous = this.samples.at(-1)?.sampledAt ?? -Infinity;
      this.samples.push({ ...sample, from: Math.max(previous, at - INTERVAL_MS) });
      if (this.samples.length > POWER_RING) this.samples.splice(0, this.samples.length - POWER_RING);
    }, MACMON_LINE_BYTES);
    child.stdout.on('data', (chunk: Buffer) => lines.push(chunk));
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true; lines.reset();
      if (this.child !== child) return;
      this.child = null;
      if (!output) this.silentExits += 1;
      // Restart only while a view still wants power; a macmon that keeps exiting silently is left alone.
      if (this.idleTimer && this.silentExits < SILENT_EXIT_LIMIT) this.scheduleRestart();
    };
    child.once('exit', end);
    child.once('error', end);
  }

  private scheduleRestart(): void {
    this.failures = Math.min(6, this.failures + 1);
    const base = this.options.restartBaseMs ?? 1_000;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.idleTimer && !this.child) this.start();
    }, Math.min(30 * base, base * 2 ** (this.failures - 1)));
    this.restartTimer.unref?.();
  }
}

export const createPowerStream = (options: PowerStreamOptions): PowerStream => new MacmonStream(options);
