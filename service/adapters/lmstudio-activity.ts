import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { Readable } from 'node:stream';
import { count, defined, nonneg, obj } from '../../src/contract/guards.ts';
import type { CompletionDraft } from '../core/adapter-v2.ts';
import { isLmsArgv, lmsArgv, loopbackPort } from '../lib/argv.ts';
import { lmsEnv, lmsModelName } from './lmstudio-cli.ts';

// Owner: ad-lmstudio. Rewrite of service/lmstudio-activity.ts bound to one connection: resets on stream restart or
// connection change; healthy only after the first parsed JSON record; BoundedLines 16 KiB and the 60 s idle-stop stay.

/** Longest log record kept by the line reader; longer records (request bodies, token dumps) are discarded unread. */
export const MAX_LOG_LINE_BYTES = 16 * 1024;
/** Records longer than this are never JSON-parsed: every lifecycle and summary record is under 1 KB. */
export const MAX_RECORD_CHARS = 2_048;
const MAX_CONTENT_CHARS = 1_024;

export type ServerLineEvent =
  | { kind: 'started'; model: string }
  | { kind: 'progress'; model: string; fraction: number }
  | { kind: 'streaming'; model: string }
  | { kind: 'done'; completion: CompletionDraft }
  /** `prediction`: "Generated prediction", which ends only a request that never announced streaming. */
  | { kind: 'finished'; model: string; prediction: boolean }
  | { kind: 'failed'; model: string };

interface ServerRecord { level: string; content: string }
/** The `{timestamp, data: {type: 'server.log', content, level}}` shape of one NDJSON line, or null. */
const serverRecord = (line: string): ServerRecord | null => {
  if (line.length > MAX_RECORD_CHARS || !line.startsWith('{')) return null;
  let record: unknown;
  try { record = JSON.parse(line); } catch { return null; }
  const data = obj(obj(record)?.data);
  return data?.type === 'server.log' && typeof data.content === 'string'
    ? { level: typeof data.level === 'string' ? data.level : '', content: data.content } : null;
};

const CONTENT = /^\[[^\]\n]{1,40}\]\[(DEBUG|INFO|WARN|WARNING|ERROR)\](?:\[([^\]\n]{1,200})\])? ?(.*)$/;
// The Splash engine's own summary, relayed by Bionic untagged at DEBUG (incoai/splash server/diagnostics.py).
const SUMMARY = /^(?:\d{2}:\d{2}:\d{2} )?Done · (.+)$/;
const tokens = (value: string): number | null => /^(?:\d{1,3}(?:,\d{3})+|\d+)$/.test(value) ? count(Number(value.replaceAll(',', ''))) : null;
const summary = (message: string, at: number): ServerLineEvent | null => {
  const match = SUMMARY.exec(message);
  if (!match) return null;
  const counts: Record<string, number | null> = {};
  let ttftMs: number | null = null, rate: number | null = null;
  for (const segment of match[1]!.split(' · ')) {
    const pair = /^(input|cached|output) ([\d,]+)$/.exec(segment), ttft = /^TTFT (\d+(?:\.\d+)?) ?(ms|s)$/.exec(segment);
    const speed = /^(\d+(?:\.\d+)?) tok\/s$/.exec(segment);
    if (pair) counts[pair[1]!] = tokens(pair[2]!);
    else if (ttft) ttftMs = nonneg(Number(ttft[1]) * (ttft[2] === 's' ? 1_000 : 1));
    else if (speed) rate = nonneg(Number(speed[1]));
  }
  const { input = null, cached = null, output = null } = counts;
  if (input === null || cached === null || output === null) return null;
  return { kind: 'done', completion: defined({
    finishedAt: at, startedAt: null, model: null, basis: 'reported' as const, overlapped: false, promptTokens: input,
    cachedTokens: cached <= input ? cached : undefined, outputTokens: output, ttftMs: ttftMs ?? undefined,
    decodeTps: rate !== null && rate > 0 && output > 0 ? rate : undefined,
  }) };
};
const eventOf = (record: ServerRecord | null, at: number): ServerLineEvent | null => {
  // One line per record: a multi-line content is a request body or generated text, never a lifecycle line.
  if (!record || record.content.length > MAX_CONTENT_CHARS || /[\r\n]/.test(record.content)) return null;
  const match = CONTENT.exec(record.content);
  if (!match) return null;
  const [, level, tag, message = ''] = match;
  // A summary counts only as its own untagged DEBUG record, never inside a tagged line of generated text.
  if (tag === undefined) return level === 'DEBUG' && (record.level === '' || record.level === 'debug') ? summary(message, at) : null;
  const model = lmsModelName(tag);
  if (!model) return null;
  if (/^Running (?:chat )?completion\b/i.test(message)) return { kind: 'started', model };
  const progress = /^Prompt processing progress: (\d{1,3}(?:\.\d+)?)%/i.exec(message);
  if (progress) { const value = Number(progress[1]); return value <= 100 ? { kind: 'progress', model, fraction: Math.round(value * 1e4) / 1e6 } : null; }
  if (/^Streaming response\b/i.test(message)) return { kind: 'streaming', model };
  if (/^Finished (?:streaming response|generating|prediction)\b/i.test(message)) return { kind: 'finished', model, prediction: false };
  if (/^Generated prediction\b/i.test(message)) return { kind: 'finished', model, prediction: true };
  return level === 'ERROR' ? { kind: 'failed', model } : null;
};
/** One `lms log stream -s server --json` record. A `Done ·` summary counts only as the record's own line, never inside generated text. */
export const parseServerRecord = (line: string, at: number): ServerLineEvent | null => eventOf(serverRecord(line), at);

export interface ActivityRequest { model: string; phase: 'prefill' | 'decode'; fraction: number | null; startedAt: number }
export interface ActivityModel { model: string; active: number; phase: 'prefill' | 'decode'; fraction: number | null }
export interface ActivityView {
  /** The stream delivered a server.log record since it (re)started; the in-flight fields below mean nothing otherwise. */
  healthy: boolean;
  active: number;                            // requests in flight: Scope's tally of start and finish lines (observed)
  request: ActivityRequest | null;           // exactly one request in flight
  models: ActivityModel[];                   // in-flight requests per model tag
  averages: { decodeTps?: number; cacheEfficiencyFraction?: number };   // derived from the summaries seen
  seen: number;                              // summaries seen on this connection
  completions: CompletionDraft[];            // finished since the previous view, oldest first
}

interface Entry { model: string; requests: number; streamed: number; starts: number[]; phase: 'prefill' | 'decode'; fraction: number | null;
  lastEventAt: number; overlapped: boolean }
const ABANDONED_MS = 30 * 60_000, RECENT_MS = 2_000, PENDING_LIMIT = 64;

/** Pure state machine over parsed events; the clock is injected. Requests on one model tag are matched first in, first out. */
export class ActivityTracker {
  private readonly entries = new Map<string, Entry>();
  private pending: CompletionDraft[] = [];
  private recent: { model: string; startedAt: number | null; overlapped: boolean; at: number } | null = null;
  private output = 0;
  private decodeSeconds = 0;
  private prompt = 0;
  private cached = 0;
  private seen = 0;

  constructor(private readonly now: () => number) {}

  private inFlight(): number { let total = 0; for (const entry of this.entries.values()) total += entry.requests; return total; }

  apply(event: ServerLineEvent): void {
    const at = this.now();
    if (event.kind === 'done') { this.done(event.completion, at); return; }
    const entry = this.entries.get(event.model);
    switch (event.kind) {
      case 'started': {
        // Any request in flight at a start overlaps it, and it overlaps them.
        const overlapping = this.inFlight() > 0;
        for (const other of this.entries.values()) other.overlapped ||= overlapping;
        if (entry) { entry.requests += 1; entry.starts.push(at); entry.phase = 'prefill'; entry.fraction = 0; entry.lastEventAt = at; }
        else this.entries.set(event.model, { model: event.model, requests: 1, streamed: 0, starts: [at], phase: 'prefill', fraction: 0,
          lastEventAt: at, overlapped: overlapping });
        return;
      }
      case 'progress':
        if (!entry) return;
        entry.lastEventAt = at;
        entry.phase = event.fraction >= 1 ? 'decode' : 'prefill';
        entry.fraction = event.fraction >= 1 ? null : event.fraction;
        return;
      case 'streaming':
        if (entry && entry.streamed < entry.requests) { entry.streamed += 1; entry.lastEventAt = at; }
        return;
      case 'finished':
        // Streamed requests end at "Finished streaming response"; a prediction line never ends one early.
        if (!entry || event.prediction && entry.requests <= entry.streamed) return;
        if (!event.prediction && entry.streamed > 0) entry.streamed -= 1;
        this.end(entry, at);
        return;
      case 'failed':
        if (entry) this.end(entry, at);
    }
  }

  private end(entry: Entry, at: number): void {
    this.recent = { model: entry.model, startedAt: entry.starts.shift() ?? null, overlapped: entry.overlapped, at };
    entry.requests -= 1;
    entry.streamed = Math.min(entry.streamed, entry.requests);
    entry.lastEventAt = at;
    if (entry.requests <= 0) this.entries.delete(entry.model);
  }

  /** The summary names no model: it is attributed only while exactly one request is in flight (or just ended). Times are this clock's. */
  private done(draft: CompletionDraft, at: number): void {
    const inFlight = this.inFlight(), owner = inFlight === 1 ? [...this.entries.values()][0]! : null;
    const recent = inFlight === 0 && this.recent && at - this.recent.at <= RECENT_MS ? this.recent : null;
    const completion: CompletionDraft = { ...draft, finishedAt: at, model: owner?.model ?? recent?.model ?? null,
      startedAt: owner ? owner.starts[0] ?? null : recent?.startedAt ?? null,
      // An unobserved span (stream joined mid-request) or several in flight cannot be called clean.
      overlapped: owner ? owner.overlapped : recent ? recent.overlapped : true };
    this.pending.push(completion);
    if (this.pending.length > PENDING_LIMIT) this.pending.shift();
    this.seen += 1;
    const { outputTokens: output, decodeTps: rate, promptTokens: prompt, cachedTokens: cached } = completion;
    if (output && rate) { this.output += output; this.decodeSeconds += output / rate; }
    if (prompt && cached !== undefined) { this.prompt += prompt; this.cached += cached; }
  }

  /** Stream restarts can drop events: never keep a request that can no longer be observed. */
  resetActive(): void { this.entries.clear(); this.recent = null; }

  drain(): CompletionDraft[] { return this.pending.splice(0); }

  view(healthy: boolean): Omit<ActivityView, 'completions'> {
    const at = this.now();
    for (const [key, entry] of this.entries) if (at - entry.lastEventAt > ABANDONED_MS) this.entries.delete(key);
    const models = healthy ? [...this.entries.values()].map(({ model, requests, phase, fraction }) => ({ model, active: requests, phase, fraction })) : [];
    const active = models.reduce((sum, entry) => sum + entry.active, 0), single = active === 1 ? [...this.entries.values()][0]! : null;
    return {
      healthy, active, models, seen: this.seen,
      request: single ? { model: single.model, phase: single.phase, fraction: single.fraction, startedAt: single.starts[0] ?? at } : null,
      averages: defined({ decodeTps: this.decodeSeconds > 0 ? this.output / this.decodeSeconds : undefined,
        cacheEfficiencyFraction: this.prompt > 0 ? this.cached / this.prompt : undefined }),
    };
  }
}

/** Splits a byte stream into lines without ever buffering more than `limit` bytes of one line. */
export class BoundedLines {
  private parts: Buffer[] = [];
  private size = 0;
  private discarding = false;

  constructor(private readonly onLine: (line: string) => void, private readonly limit = MAX_LOG_LINE_BYTES) {}

  push(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      if (!this.discarding) {
        const piece = chunk.subarray(start, end);
        if (this.size + piece.length > this.limit) { this.discarding = true; this.parts = []; this.size = 0; }
        else if (piece.length) { this.parts.push(Buffer.from(piece)); this.size += piece.length; }
      }
      if (newline === -1) return;
      if (!this.discarding) this.onLine(Buffer.concat(this.parts, this.size).toString('utf8').replace(/\r$/, ''));
      this.reset();
      start = newline + 1;
    }
  }

  reset(): void { this.parts = []; this.size = 0; this.discarding = false; }
}

export interface ConnectionActivity {
  /** Starts or keeps the stream for this port; called only after a greeting within 10 s. */
  touch(port: number): void;
  view(): ActivityView | null;
  dispose(): void;
}
/** The stream child as the activity uses it; tests pass a fake. */
export interface StreamChild {
  stdout: Readable | null;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown;
}
export type StreamSpawn = (file: string, args: string[], env: NodeJS.ProcessEnv) => StreamChild;
const streamSpawn: StreamSpawn = (file, args, env) => spawn(file, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env });
export interface ActivityOptions {
  lms: string | null;                        // an allowlisted lms under `home`, or null: never spawn
  serverInfoPath: string;
  now: () => number;
  home?: string;
  spawn?: StreamSpawn;
  idleStopMs?: number;                       // default 60 s after the last touch
  restartBaseMs?: number;                    // restart backoff base, doubling to 30×
}
export const IDLE_STOP_MS = 60_000;
const SILENT_EXIT_LIMIT = 5;

/**
 * `lms log stream -s server --json --port <internal>` for one connection. It spawns only inside `touch`, which the
 * adapter calls right after a fresh greeting, so a stream that ended (or an app that quit) is never restarted by a
 * timer: the backoff only delays the next touch's start. It stops 60 s after the last touch.
 */
class StreamActivity implements ConnectionActivity {
  private readonly tracker: ActivityTracker;
  private readonly home: string;
  private readonly spawnStream: StreamSpawn;
  private readonly idleStopMs: number;
  private readonly restartBaseMs: number;
  private child: StreamChild | null = null;
  private port: number | null = null;
  private healthy = false;
  private failures = 0;
  private silentExits = 0;
  private retryAt = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly options: ActivityOptions) {
    this.tracker = new ActivityTracker(options.now);
    this.home = options.home ?? homedir();
    this.spawnStream = options.spawn ?? streamSpawn;
    this.idleStopMs = options.idleStopMs ?? IDLE_STOP_MS;
    this.restartBaseMs = options.restartBaseMs ?? 1_000;
  }

  touch(port: number): void {
    const target = loopbackPort(port);
    if (this.disposed || this.options.lms === null || target === null) return;
    // The app restarted on another internal port: what the old stream saw in flight can no longer be observed.
    if (this.port !== null && this.port !== target) this.stop();
    this.port = target;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.idleStopMs);
    this.idleTimer.unref?.();
    if (!this.child && this.silentExits < SILENT_EXIT_LIMIT && this.options.now() >= this.retryAt) this.start(target);
  }

  view(): ActivityView | null {
    if (this.disposed || this.options.lms === null || this.port === null) return null;
    return { ...this.tracker.view(this.healthy), completions: this.tracker.drain() };
  }

  dispose(): void { this.disposed = true; this.stop(); }

  private stop(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const child = this.child;
    this.child = null;
    this.healthy = false;
    this.failures = 0;
    this.silentExits = 0;
    this.retryAt = 0;
    this.tracker.resetActive();
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM'); } catch { /* Already exited. */ }
    }
  }

  private start(port: number): void {
    const argv = lmsArgv(this.options.lms!, 'log-stream', port, this.options.serverInfoPath);
    if (!argv || !isLmsArgv(argv, this.home)) return;
    let child: StreamChild;
    try { child = this.spawnStream(argv.file, [...argv.args], lmsEnv(argv, this.home)); } catch { this.ended(false); return; }
    this.child = child;
    let output = false;
    const lines = new BoundedLines(line => {
      if (this.child !== child) return;
      const record = serverRecord(line);
      if (record && !this.healthy) { this.healthy = true; this.failures = 0; this.silentExits = 0; }
      const event = eventOf(record, this.options.now());
      if (event) this.tracker.apply(event);
    });
    child.stdout?.on('data', (chunk: Buffer) => { output = true; lines.push(chunk); });
    const ended = () => {
      if (this.child !== child) return;
      this.child = null;
      lines.reset();
      this.ended(output);
    };
    child.once('exit', ended);
    child.once('error', ended);
  }

  private ended(output: boolean): void {
    this.healthy = false;
    this.tracker.resetActive();
    // An lms that exits without output keeps failing to connect: give up until the stream idles out.
    if (!output) this.silentExits += 1;
    this.failures = Math.min(6, this.failures + 1);
    this.retryAt = this.options.now() + Math.min(30 * this.restartBaseMs, this.restartBaseMs * 2 ** (this.failures - 1));
  }
}

export const createConnectionActivity = (options: ActivityOptions): ConnectionActivity => new StreamActivity(options);
