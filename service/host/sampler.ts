import { cpus, freemem, platform as osPlatform, totalmem } from 'node:os';
import { defined, label } from '../../src/contract/guards.ts';
import type { HostV2, MacV2, Platform } from '../../src/contract/host.ts';
import type { Tier } from '../core/adapter-v2.ts';
import { createStreamSpawn, footprintArgv, ioregArgv, lsofListenArgv, notifyutilArgv, sysctlArgv, vmStatArgv, type Argv, type Exec, type StreamSpawn } from '../lib/argv.ts';
import { parseFootprintReport, parseLsofPids, sameProcess, type FootprintReport } from './footprint.ts';
import { parseIoreg } from './gpu.ts';
import { parseSysctl, parseVmStat } from './memory.ts';
import { createPowerStream, findMacmon, type PowerStream } from './power.ts';
import { parseNotifyutil } from './thermal.ts';

// Owner: svc-host. Rewrite of service/system.ts on HostV2 with the §4.4 probe tiers and spawn budget. setTimeout only:
// every probe runs inside a view-driven `sample`, so nothing spawns while no frame is reading.

/** Probe cadences in ms (contract §8): [full idle, full active, glance]; null = not on that tier. */
export const PROBE_CADENCE = {
  memory: [10_000, 10_000, 10_000], gpu: [15_000, 5_000, 15_000], thermal: [60_000, 60_000, 60_000],
  listener: [120_000, 120_000, null], footprint: [30_000, 10_000, null],
} as const;
export const SPAWN_BUDGET_PER_MIN = { idle: 24, active: 36, glance: 18 } as const;
export type Probe = keyof typeof PROBE_CADENCE;
/** Children per probe read: memory is the vm_stat + sysctl pair. */
const SPAWNS: Record<Probe, number> = { memory: 2, gpu: 1, thermal: 1, listener: 1, footprint: 1 };
/** A part outlives failed or skipped reads for this many of its longest cadence; after that it is a gap, not a stale value. */
const TTL_CADENCES = 3;
const BASE_CACHE_MS = 2_000, CPU_REPRIME_MS = 10_000, MACMON_RECHECK_MS = 300_000, BUDGET_WINDOW_MS = 60_000;

/** What the sampler needs from the reading it rides along with. `omlxPort` enables lsof → footprint. */
export interface HostContext { tier: Tier; active: boolean; generation: number; omlxPort: number | null }
export interface HostSamplerOptions {
  exec: Exec; now: () => number; platform?: string; home?: string;
  monotonic?: () => number;
  /** The macmon to stream (one of MACMON_PATHS) or null; default: the first installed one, re-checked every 5 min. */
  macmon?: string | null;
  spawn?: StreamSpawn;
  os?: { cpus: typeof cpus; freemem: typeof freemem; totalmem: typeof totalmem };
}

export const probeCadence = (probe: Probe, context: Pick<HostContext, 'tier' | 'active'>): number | null => {
  const [idle, active, glance] = PROBE_CADENCE[probe];
  return context.tier === 'glance' ? glance : context.active ? active : idle;
};
export const spawnBudget = (context: Pick<HostContext, 'tier' | 'active'>): number =>
  context.tier === 'glance' ? SPAWN_BUDGET_PER_MIN.glance : context.active ? SPAWN_BUDGET_PER_MIN.active : SPAWN_BUDGET_PER_MIN.idle;
const ttl = (probe: Probe): number => TTL_CADENCES * Math.max(...PROBE_CADENCE[probe].map(ms => ms ?? 0));

type Ticks = { idle: number; total: number };
/** Busy share of all cores between two tick readings; null without a valid interval. */
export const cpuFraction = (previous: Ticks | null, current: Ticks): number | null => {
  if (previous === null) return null;
  const total = current.total - previous.total, idle = current.idle - previous.idle;
  return Number.isFinite(total) && Number.isFinite(idle) && total > 0 && idle >= 0 && idle <= total ? 1 - idle / total : null;
};
const PLATFORMS: Record<string, Platform> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };
type Base = Pick<HostV2, 'sampledAt' | 'platform' | 'cpuModel' | 'logicalCores' | 'cpuFraction' | 'memTotalBytes' | 'memUsedBytes'>;
/** The listener lsof found. `identity` is the first footprint report after it: the PID-reuse guard (footprint.ts). */
interface Listener { port: number; generation: number; pid: number | null; identity: Pick<FootprintReport, 'name' | 'pid' | 'peakBytes'> | null }

export class HostSampler {
  private readonly platform: Platform;
  private readonly darwin: boolean;
  private readonly monotonic: () => number;
  private base: Base | null = null;
  private baseAt = -Infinity;
  private ticks: Ticks | null = null;
  private mac: MacV2 | undefined;
  private gpu: HostV2['gpu'];
  private thermal: HostV2['thermal'];
  private process: HostV2['runtimeProcess'];
  private listener: Listener | null = null;
  private readonly attempts: Record<Probe, number> = { memory: -Infinity, gpu: -Infinity, thermal: -Infinity, listener: -Infinity, footprint: -Infinity };
  private readonly flights: Partial<Record<Probe, Promise<void>>> = {};
  /** Monotonic times of the children started in the last minute. */
  private spawns: number[] = [];
  private power: PowerStream | null = null;
  private macmonCheckedAt = -Infinity;
  private disposed = false;

  constructor(private readonly options: HostSamplerOptions) {
    const name = options.platform ?? osPlatform();
    this.platform = PLATFORMS[name] ?? 'Host';
    this.darwin = name === 'darwin';
    this.monotonic = options.monotonic ?? (() => performance.now());
  }

  /** Cached parts younger than their cadence are reused; a part without a reading is left out. */
  async sample(context: HostContext): Promise<HostV2 | null> {
    let base: Base;
    try { base = this.basePart(); } catch { return null; }
    if (!this.darwin || this.disposed) return base;
    // Started in priority order, so under a tight budget pressure and thermal outrank GPU and footprint.
    await Promise.all([this.run('memory', context, () => this.readMemory()), this.run('thermal', context, () => this.readThermal()),
      this.run('gpu', context, () => this.readGpu()), this.readProcess(context)]);
    // macmon streams for full-tier views only (§4.4); a glance read shows a live stream but never extends it.
    if (context.tier === 'full') this.powerStream()?.touch();
    const now = this.options.now();
    return defined({ ...base, mac: this.fresh(this.mac, 'memory', now), gpu: this.fresh(this.gpu, 'gpu', now),
      thermal: this.fresh(this.thermal, 'thermal', now),
      runtimeProcess: this.process?.port === context.omlxPort ? this.fresh(this.process, 'footprint', now) : undefined, power: this.power?.view(now) });
  }

  /** macmon estimate over [from, to] for CompletionV2.host.energyJ; null below 80% coverage or without macmon. */
  energy(from: number, to: number): { energyJ: number; coverage: number } | null { return this.power?.energy(from, to) ?? null; }

  /** Stops the macmon stream and pending timers. */
  dispose(): void { this.disposed = true; this.power?.dispose(); this.power = null; }

  private fresh<T extends { sampledAt: number }>(part: T | undefined, probe: Probe, now: number): T | undefined {
    return part && now - part.sampledAt <= ttl(probe) ? part : undefined;
  }

  private basePart(): Base {
    const at = this.monotonic(), age = at - this.baseAt;
    if (this.base && age >= 0 && age < BASE_CACHE_MS) return this.base;
    const os = this.options.os ?? { cpus, freemem, totalmem }, cores = os.cpus();
    const ticks = cores.reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
      total: sum.total + Object.values(cpu.times).reduce((all, time) => all + time, 0) }), { idle: 0, total: 0 });
    // After suspension or a long gap, re-prime: an average over sleep is not current CPU.
    const busy = cores.length > 0 && age >= 0 && age <= CPU_REPRIME_MS ? cpuFraction(this.ticks, ticks) : null;
    const total = os.totalmem(), free = os.freemem();
    const memory = Number.isSafeInteger(total) && total > 0 && Number.isSafeInteger(free) && free >= 0 && free <= total;
    this.ticks = ticks; this.baseAt = at;
    this.base = defined({ sampledAt: this.options.now(), platform: this.platform, cpuModel: label(cores[0]?.model, 80) ?? undefined,
      logicalCores: cores.length || undefined, cpuFraction: busy ?? undefined,
      memTotalBytes: memory ? total : undefined, memUsedBytes: memory ? total - free : undefined });
    return this.base;
  }

  /** Runs a probe when it is due (or `force`d) and the spawn budget allows; concurrent reads share one flight. */
  private run(probe: Probe, context: HostContext, read: () => Promise<void>, force = false): Promise<void> {
    const flight = this.flights[probe];
    if (flight) return flight;
    const every = probeCadence(probe, context), at = this.monotonic();
    if (every === null || !force && at - this.attempts[probe] < every || !this.reserve(SPAWNS[probe], context, at)) return Promise.resolve();
    this.attempts[probe] = at;
    const running = read().catch(() => {}).finally(() => { delete this.flights[probe]; });
    this.flights[probe] = running;
    return running;
  }

  /** The §4.4 ceiling over any 60 s window, whatever mix of tiers and frames is reading. */
  private reserve(children: number, context: HostContext, at: number): boolean {
    this.spawns = this.spawns.filter(time => at - time < BUDGET_WINDOW_MS);
    if (this.spawns.length + children > spawnBudget(context)) return false;
    for (let child = 0; child < children; child++) this.spawns.push(at);
    return true;
  }

  private async exec(argv: Argv | null): Promise<string | null> {
    if (!argv) return null;
    try { return await this.options.exec(argv); } catch { return null; }
  }

  private async readMemory(): Promise<void> {
    const [vm, sysctl] = await Promise.all([this.exec(vmStatArgv()), this.exec(sysctlArgv())]);
    const mac = { ...parseVmStat(vm), ...parseSysctl(sysctl) };
    if (Object.keys(mac).length) this.mac = { sampledAt: this.options.now(), ...mac };
  }

  private async readGpu(): Promise<void> {
    const gpu = parseIoreg(await this.exec(ioregArgv()), this.options.now());
    if (gpu) this.gpu = gpu;
  }

  private async readThermal(): Promise<void> {
    const level = parseNotifyutil(await this.exec(notifyutilArgv()));
    if (level !== null) this.thermal = { sampledAt: this.options.now(), level };
  }

  /**
   * oMLX only: the process listening on its loopback port. lsof on a new port or generation, else every 120 s; footprint
   * on its own cadence, right after a new lsof, and only while the PID still passes the reuse guard.
   */
  private async readProcess(context: HostContext): Promise<void> {
    // A frame on another connection neither reads nor resets the listener; the reuse guard covers a restart meanwhile.
    const port = context.omlxPort;
    if (port === null || context.tier !== 'full') return;
    const known = this.listener, changed = !known || known.port !== port || known.generation !== context.generation;
    if (known && changed) this.process = undefined;
    await this.run('listener', context, async () => {
      const pids = parseLsofPids(await this.exec(lsofListenArgv(port)));
      // A parent and a forked worker on one socket make the owner ambiguous: no footprint rather than a guess.
      this.listener = { port, generation: context.generation, pid: pids.length === 1 ? pids[0]! : null, identity: null };
      this.attempts.footprint = -Infinity;
      if (this.listener.pid === null) this.process = undefined;
    }, changed);
    const listener = this.listener;
    if (!listener || listener.pid === null || listener.port !== port || listener.generation !== context.generation) return;
    await this.run('footprint', context, async () => {
      const report = parseFootprintReport(await this.exec(footprintArgv(listener.pid!)));
      if (this.listener !== listener) return;
      if (!report || listener.identity && !sameProcess(listener.identity, report)) { this.listener = null; this.process = undefined; return; }
      listener.identity = { name: report.name, pid: report.pid, peakBytes: report.peakBytes };
      this.process = { sampledAt: this.options.now(), runtime: 'omlx', port, footprintBytes: report.footprintBytes };
    });
  }

  private powerStream(): PowerStream | null {
    if (this.power || this.disposed) return this.power;
    const at = this.monotonic(), explicit = this.options.macmon !== undefined;
    // An install after startup is found within 5 min: a stat, never a spawn.
    if (at - this.macmonCheckedAt < (explicit ? Infinity : MACMON_RECHECK_MS)) return null;
    this.macmonCheckedAt = at;
    const macmon = explicit ? this.options.macmon! : findMacmon();
    if (macmon) this.power = createPowerStream({ macmon, now: this.options.now, spawn: this.options.spawn ?? createStreamSpawn(this.options.home ?? '') });
    return this.power;
  }
}
