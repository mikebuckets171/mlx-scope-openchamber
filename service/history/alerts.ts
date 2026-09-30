import { MAX_ALERT_LOG, type AlertLogEntryV2, type AlertV2, type Severity } from '../../src/contract/alerts.ts';
import { defined } from '../../src/contract/guards.ts';
import type { HostV2 } from '../../src/contract/host.ts';
import { ALERT_PARAMS, parseParams, type AlertId, type ReasonParams } from '../../src/contract/reasons.ts';
import type { RuntimeKind } from '../../src/contract/runtime.ts';
import type { Phase, RequestV2, StatusV2 } from '../../src/contract/snapshot.ts';

// Owner: svc-history. Host and runtime alerts evaluated at request time (plan §5.7 minus near-gpu-limit): hysteresis,
// dwell and cooldown on a fake-clock table; windowed alerts only inside one contiguous segment with ≥ 80 % coverage.

export const TOAST_LIMITS = { perMinute: 1, perHour: 3 } as const;
const MINUTE = 60_000, HOUR = 3_600_000;
export const GIB = 2 ** 30;
/** +1 GiB within 5 min starts it, measured inside one segment covering ≥ 80 % of the window; under 0.5 GiB ends it. */
export const SWAP_GROWTH = { windowMs: 300_000, coverage: 0.8, onBytes: GIB, offBytes: GIB / 2 } as const;
/** A toast is offered only this soon after its alert starts; later the in-view alert says it. */
export const TOAST_FRESH_MS = 60_000;
/** Host evaluations further apart than this (2.5 × the slowest 10 s poll) break the host timeline. */
export const HOST_GAP_MS = 25_000;
/** A host part older than this is no reading of now: 3 probe intervals (pressure and swap 10 s, thermal 60 s). */
export const PART_FRESH_MS = { mac: 30_000, thermal: 180_000 } as const;
/** Slots whose runtime alerts are kept; the least recently evaluated leaves first. */
export const ALERT_SLOTS = 16;
const DEFAULT_KEY = 'default';

export interface AlertRule {
  scope: 'runtime' | 'host';
  severity: Severity;
  badge: boolean;
  toast: boolean;
  onMs: number;                              // dwell: the condition holds this long before the alert starts
  offMs: number;                             // hysteresis: the condition is gone this long before it ends
  cooldownMs: number;                        // between two toasts of this alert; 0 = once per episode
}
/**
 * Plan §5.7 with G1 (no GPU alert of any kind). Splash recovering, the oMLX prefill stall and memory guard stay in view
 * only (1.6 behaviour): no badge, no toast. There is never an alert on GPU utilisation.
 */
export const ALERT_RULES: Readonly<Record<AlertId, AlertRule>> = {
  'runtime-lost': { scope: 'runtime', severity: 'critical', badge: true, toast: true, onMs: 5_000, offMs: 0, cooldownMs: 0 },
  'model-unloaded': { scope: 'runtime', severity: 'info', badge: true, toast: true, onMs: 0, offMs: 0, cooldownMs: 30 * MINUTE },
  'pressure-warning': { scope: 'host', severity: 'warning', badge: true, toast: false, onMs: 10_000, offMs: 30_000, cooldownMs: 0 },
  'pressure-critical': { scope: 'host', severity: 'critical', badge: true, toast: true, onMs: 0, offMs: 30_000, cooldownMs: 30 * MINUTE },
  'swap-growth': { scope: 'host', severity: 'info', badge: true, toast: true, onMs: 0, offMs: 60_000, cooldownMs: 30 * MINUTE },
  thermal: { scope: 'host', severity: 'warning', badge: true, toast: true, onMs: 0, offMs: 60_000, cooldownMs: 30 * MINUTE },
  'splash-recovering': { scope: 'runtime', severity: 'warning', badge: false, toast: false, onMs: 0, offMs: 0, cooldownMs: 0 },
  'omlx-prefill-stall': { scope: 'runtime', severity: 'warning', badge: false, toast: false, onMs: 30_000, offMs: 0, cooldownMs: 0 },
  'omlx-memory-guard': { scope: 'runtime', severity: 'warning', badge: false, toast: false, onMs: 0, offMs: 10_000, cooldownMs: 0 },
};
const SEVERITY_RANK: Readonly<Record<Severity, number>> = { critical: 3, warning: 2, info: 1 };

export interface AlertInput {
  at: number;
  status: StatusV2;
  phase: Phase;
  loadedModels: number | null;               // model-unloaded fires on a drop to 0
  host: HostV2 | null;
  covered: boolean;                          // this reading continues the current segment
  key?: string;                              // the connection slot; runtime alerts are kept per slot, host alerts once
  runtime?: RuntimeKind | null;
  model?: string | null;                     // a loaded model, named in view (never in a toast) if the count drops to 0
  request?: Pick<RequestV2, 'prefillStale'> | null;
  guardLevel?: number | null;                // oMLX process memory guard 0–3, not macOS pressure
}

interface Episode { id: AlertId; since: number; until: number | null; params: ReasonParams; startedAt: number; toast?: number | null }
interface Track { onsetAt: number | null; offAt: number | null; episode: Episode | null }
interface RuntimeState { lastAt: number; tracks: Map<AlertId, Track>; alive: boolean; loaded: number | null; model: string | null; unloaded: { model: string | null } | null }
const track = (tracks: Map<AlertId, Track>, id: AlertId): Track => {
  let item = tracks.get(id);
  if (!item) tracks.set(id, item = { onsetAt: null, offAt: null, episode: null });
  return item;
};
const fresh = <T extends { sampledAt: number }>(part: T | undefined, at: number, maxAgeMs: number): T | undefined =>
  part && at - part.sampledAt <= maxAgeMs && part.sampledAt <= at + MINUTE ? part : undefined;
const larger = (key: string) => (previous: ReasonParams, next: ReasonParams): ReasonParams =>
  Number(next[key] ?? -Infinity) > Number(previous[key] ?? -Infinity) ? next : previous;

/** ≤ 1 toast per minute and ≤ 3 per hour, in service memory, so a leader handover does not reset them. */
export class ToastLimiter {
  private readonly granted: number[] = [];
  allow(now: number): boolean {
    while (this.granted.length && now - this.granted[0]! >= HOUR) this.granted.shift();
    // A clock that went back counts as recent: the limit errs towards fewer toasts.
    const lastMinute = this.granted.filter(at => now - at < MINUTE).length;
    if (this.granted.length >= TOAST_LIMITS.perHour || lastMinute >= TOAST_LIMITS.perMinute) return false;
    this.granted.push(now);
    return true;
  }
}

/**
 * Alert episodes from what frames' reads saw, in service memory only. Runtime alerts belong to one connection slot;
 * host alerts are shared. A gap in the readings ends every open episode at the last reading: nothing is known after it,
 * and a dwell or a window never spans it. Toasts are decided once per episode, for the leader only.
 */
export class AlertBook {
  private readonly runtimes = new Map<string, RuntimeState>();
  private readonly host = { lastAt: -Infinity, segmentAt: -Infinity, swap: [] as Array<[at: number, bytes: number]>, tracks: new Map<AlertId, Track>() };
  private readonly log: Episode[] = [];
  private readonly lastToast = new Map<AlertId, number>();
  private toastSeq = 0;
  constructor(private readonly limiter = new ToastLimiter()) {}

  evaluate(input: AlertInput): void {
    if (!Number.isFinite(input.at)) return;
    this.evaluateRuntime(input);
    this.evaluateHost(input);
  }

  /** Active alerts for this slot plus the host's (toastSeq only for the leader) and the ≤ 20 entry log, newest first. */
  view(leader: boolean, now: number, key = DEFAULT_KEY): { alerts: AlertV2[]; alertLog: AlertLogEntryV2[] } {
    const open = [...this.host.tracks.entries(), ...this.runtimes.get(key)?.tracks.entries() ?? []]
      .flatMap(([id, item]) => item.episode ? [[id, item.episode] as const] : [])
      .sort(([a, x], [b, y]) => SEVERITY_RANK[ALERT_RULES[b].severity] - SEVERITY_RANK[ALERT_RULES[a].severity] || x.since - y.since);
    if (leader) for (const [id, episode] of open) this.offerToast(id, episode, now);
    return {
      alerts: open.map(([id, episode]) => defined({
        id, severity: ALERT_RULES[id].severity, since: episode.since, params: this.params(episode, now), badge: ALERT_RULES[id].badge,
        toastSeq: leader && typeof episode.toast === 'number' ? episode.toast : undefined,
      })),
      alertLog: [...this.log].sort((a, b) => b.since - a.since).slice(0, MAX_ALERT_LOG)
        .map(episode => ({ id: episode.id, severity: ALERT_RULES[episode.id].severity, since: episode.since, until: episode.until, params: this.params(episode, now) })),
    };
  }

  private evaluateRuntime(input: AlertInput): void {
    const key = input.key ?? DEFAULT_KEY, { at, status } = input;
    let state = this.runtimes.get(key);
    if (state && at < state.lastAt) return;
    if (!state) {
      state = { lastAt: at, tracks: new Map(), alive: false, loaded: null, model: null, unloaded: null };
      this.runtimes.set(key, state);
      this.evictRuntimes();
    } else {
      this.runtimes.delete(key); this.runtimes.set(key, state);
      if (!input.covered) { this.gap(state.tracks, state.lastAt); Object.assign(state, { alive: false, loaded: null, model: null, unloaded: null }); }
    }
    state.lastAt = at;
    const failing = status.state === 'failing';
    if (status.state === 'ready' || status.state === 'degraded' || status.state === 'recovering') state.alive = true;
    // Only a loss seen inside a segment: a view opened on a stopped runtime shows its status, not an alert.
    this.step(state.tracks, 'runtime-lost', state.alive && failing && status.reason === 'runtime_unreachable', at, input.runtime ? { runtime: input.runtime } : {});
    // A restart is not an unload: counts start over once the runtime answers again.
    if (failing) Object.assign(state, { loaded: null, unloaded: null });
    else if (input.loadedModels !== null) {
      if (state.loaded !== null && state.loaded > 0 && input.loadedModels === 0) state.unloaded = { model: state.model };
      if (input.loadedModels > 0) { state.unloaded = null; if (input.model) state.model = input.model; }
      state.loaded = input.loadedModels;
    }
    this.step(state.tracks, 'model-unloaded', state.unloaded !== null, at, state.unloaded?.model ? { model: state.unloaded.model } : {});
    this.step(state.tracks, 'splash-recovering', status.state === 'recovering', at, status.state === 'recovering' ? status.params : {});
    this.step(state.tracks, 'omlx-prefill-stall', input.runtime === 'omlx' && input.phase === 'prefill' && input.request?.prefillStale === true, at, {});
    this.step(state.tracks, 'omlx-memory-guard', input.runtime === 'omlx' && !failing && (input.guardLevel ?? 0) >= 2, at, {});
  }

  private evaluateHost(input: AlertInput): void {
    const { at } = input, host = this.host;
    if (at < host.lastAt) return;
    // Another slot's recent read keeps the host timeline going even when this slot starts a segment.
    if (host.lastAt === -Infinity || !input.covered && at - host.lastAt > HOST_GAP_MS) { this.gap(host.tracks, host.lastAt); host.segmentAt = at; host.swap = []; }
    host.lastAt = at;
    const mac = fresh(input.host?.mac, at, PART_FRESH_MS.mac), level = mac?.pressureLevel;
    this.step(host.tracks, 'pressure-critical', level === undefined ? null : level === 4, at, { level: 4 });
    const critical = track(host.tracks, 'pressure-critical').episode !== null, warning = track(host.tracks, 'pressure-warning');
    if (critical) {
      // Critical supersedes warning; warning may start again after critical ends.
      if (warning.episode) this.close(warning.episode, at);
      Object.assign(warning, { onsetAt: null, offAt: null, episode: null });
    } else this.step(host.tracks, 'pressure-warning', level === undefined ? null : level === 2, at, { level: 2 });
    const thermal = fresh(input.host?.thermal, at, PART_FRESH_MS.thermal);
    this.step(host.tracks, 'thermal', thermal ? thermal.level >= 2 : null, at, thermal ? { level: thermal.level } : {}, larger('level'));
    this.stepSwap(mac?.sampledAt, mac?.swapUsedBytes, at);
  }

  private stepSwap(sampledAt: number | undefined, bytes: number | undefined, at: number): void {
    const host = this.host, { windowMs, coverage, onBytes, offBytes } = SWAP_GROWTH;
    if (sampledAt !== undefined && bytes !== undefined && sampledAt >= host.segmentAt && !(sampledAt <= (host.swap.at(-1)?.[0] ?? -Infinity))) host.swap.push([sampledAt, bytes]);
    while (host.swap.length && host.swap[0]![0] < at - windowMs) host.swap.shift();
    if (bytes === undefined || !host.swap.length) { this.step(host.tracks, 'swap-growth', null, at, {}); return; }
    const span = Math.min(windowMs, at - host.segmentAt), growth = host.swap.at(-1)![1] - Math.min(...host.swap.map(([, value]) => value));
    const open = track(host.tracks, 'swap-growth').episode !== null;
    const condition = open ? growth >= offBytes : span >= coverage * windowMs && growth >= onBytes;
    this.step(host.tracks, 'swap-growth', condition, at, { deltaBytes: growth, windowMs: Math.round(span / 1_000) * 1_000 }, larger('deltaBytes'));
  }

  private step(tracks: Map<AlertId, Track>, id: AlertId, condition: boolean | null, at: number, params: ReasonParams,
    merge: (previous: ReasonParams, next: ReasonParams) => ReasonParams = (_, next) => next): void {
    if (condition === null) return;
    const item = track(tracks, id), rule = ALERT_RULES[id];
    if (condition) {
      item.offAt = null;
      if (item.episode) { item.episode.params = merge(item.episode.params, params); return; }
      item.onsetAt ??= at;
      if (at - item.onsetAt >= rule.onMs) item.episode = this.open(id, item.onsetAt, at, params);
      return;
    }
    item.onsetAt = null;
    if (!item.episode) return;
    item.offAt ??= at;
    if (at - item.offAt >= rule.offMs) { this.close(item.episode, item.offAt); Object.assign(item, { offAt: null, episode: null }); }
  }

  private open(id: AlertId, since: number, at: number, params: ReasonParams): Episode {
    const episode: Episode = { id, since, until: null, params, startedAt: at };
    this.log.push(episode);
    if (this.log.length > MAX_ALERT_LOG) this.log.splice(this.log.indexOf([...this.log].sort((a, b) => a.since - b.since)[0]!), 1);
    return episode;
  }
  private close(episode: Episode, until: number): void { episode.until = Math.max(episode.since, until); }
  private gap(tracks: Map<AlertId, Track>, lastAt: number): void {
    for (const item of tracks.values()) {
      if (item.episode) this.close(item.episode, lastAt);
      Object.assign(item, { onsetAt: null, offAt: null, episode: null });
    }
  }
  private evictRuntimes(): void {
    for (const [key, state] of this.runtimes) {
      if (this.runtimes.size <= ALERT_SLOTS) break;
      this.gap(state.tracks, state.lastAt);
      this.runtimes.delete(key);
    }
  }

  /** Once per episode: within a minute of its start, past this alert's cooldown, and inside the service-wide limits. */
  private offerToast(id: AlertId, episode: Episode, now: number): void {
    const rule = ALERT_RULES[id];
    if (!rule.toast || episode.toast !== undefined) return;
    const last = this.lastToast.get(id);
    if (now - episode.startedAt > TOAST_FRESH_MS || rule.cooldownMs && last !== undefined && now - last < rule.cooldownMs || !this.limiter.allow(now)) {
      episode.toast = null;
      return;
    }
    episode.toast = ++this.toastSeq;
    this.lastToast.set(id, now);
  }

  /** Allowlisted params only; a stall's duration runs until it ends. */
  private params(episode: Episode, now: number): ReasonParams {
    const params = episode.id === 'omlx-prefill-stall' ? { stalledMs: Math.max(0, (episode.until ?? now) - episode.since) } : episode.params;
    return parseParams(params, ALERT_PARAMS[episode.id]);
  }
}
