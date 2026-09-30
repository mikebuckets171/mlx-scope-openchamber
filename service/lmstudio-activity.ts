import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

/** One recognised line of LM Studio's redacted server log. Prompt and output text are never read. */
export type LMStudioLogEvent =
  | { kind: 'request'; model: string }
  | { kind: 'prefill'; model: string; progress: number }
  | { kind: 'done'; promptTokens: number | null; cachedTokens: number | null; outputTokens: number | null;
      ttftSeconds: number | null; tokensPerSecond: number | null }
  | { kind: 'streaming'; model: string }
  | { kind: 'finished'; model: string }
  /** Non-streaming completions end with "Generated prediction" instead of "Finished streaming response". */
  | { kind: 'prediction'; model: string }
  | { kind: 'failed'; model: string | null };

export type LMStudioLastRequest = {
  model: string | null;
  tokensPerSecond: number | null;
  ttftSeconds: number | null;
  promptTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  finishedAt: number;
};

export type LMStudioActivityView = {
  /** The single in-flight request. Null when idle or when requests overlap (see `concurrent`). */
  active: { model: string; phase: 'prefill' | 'decode'; progress: number | null; startedAt: number; requests: number } | null;
  /** True when more than one request is in flight: log lines cannot be attributed to one request. */
  concurrent: boolean;
  activeRequests: number;
  lastRequest: LMStudioLastRequest | null;
  completedRequests: number;
  averageDecodeTPS: number | null;
  cacheEfficiencyPercent: number | null;
};

const LINE = /^\[[^\]]*\]\[(INFO|DEBUG|WARN|WARNING|ERROR)\](?:\[([^\]]+)\])?\s*(.*)$/;
const integer = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number(value.replace(/,/g, ''));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};
const decimal = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number(value.replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
/** Same boundary as inventory names: absolute or URL-like paths are reduced to their final segment. */
const cleanModel = (value: string | undefined): string | null => {
  let clean = value?.replace(/[\u0000-\u001f\u007f]/g, '').trim() ?? '';
  if (/^(?:[\\/]|\.{1,2}[\\/]|[a-z]:[\\/]|~[\\/]|[a-z][a-z0-9+.-]*:\/\/|file:)/i.test(clean)) {
    clean = clean.replace(/[?#].*$/, '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').at(-1) ?? '';
  }
  return clean ? clean.slice(0, 160) : null;
};

export function parseLMStudioServerLine(content: string): LMStudioLogEvent | null {
  const match = LINE.exec(content.trim());
  if (!match) return null;
  const [, level, tag, rest] = match;
  const model = cleanModel(tag);
  if (/^Running (?:chat )?completion\b/i.test(rest)) return model ? { kind: 'request', model } : null;
  const progress = /^Prompt processing progress:\s*([\d.]+)%/i.exec(rest);
  if (progress) {
    const value = decimal(progress[1]);
    return model && value !== null ? { kind: 'prefill', model, progress: Math.min(1, value / 100) } : null;
  }
  if (/(?:^|\s)Done\s*·/.test(rest)) {
    const field = (name: string) => new RegExp(`${name}\\s+([\\d,]+)`, 'i').exec(rest)?.[1];
    return {
      kind: 'done',
      promptTokens: integer(field('input')),
      cachedTokens: integer(field('cached')),
      outputTokens: integer(field('output')),
      ttftSeconds: decimal(/TTFT\s+([\d.,]+)\s*s/i.exec(rest)?.[1]),
      tokensPerSecond: decimal(/([\d.,]+)\s*tok\/s/i.exec(rest)?.[1]),
    };
  }
  if (/^Streaming response\b/i.test(rest)) return model ? { kind: 'streaming', model } : null;
  if (/^Finished (?:streaming response|generating|prediction)/i.test(rest)) return model ? { kind: 'finished', model } : null;
  if (/^Generated prediction\b/i.test(rest)) return model ? { kind: 'prediction', model } : null;
  if (level === 'ERROR' && model) return { kind: 'failed', model };
  return null;
}

type Active = { model: string; phase: 'prefill' | 'decode'; progress: number | null; startedAt: number; lastEventAt: number; requests: number; streamed: number };
const ABANDONED_MS = 30 * 60_000;

/** Pure state machine over parsed log events; clocks are injected for tests. */
export class LMStudioActivityTracker {
  private readonly active = new Map<string, Active>();
  private recentModel: string | null = null;
  private last: LMStudioLastRequest | null = null;
  private completed = 0;
  private outputTokens = 0;
  private decodeSeconds = 0;
  private promptTokens = 0;
  private cachedTokens = 0;

  constructor(private readonly now: () => number = Date.now) {}

  apply(event: LMStudioLogEvent): void {
    const at = this.now();
    switch (event.kind) {
      case 'request': {
        const entry = this.active.get(event.model);
        if (entry) { entry.requests += 1; entry.lastEventAt = at; entry.phase = 'prefill'; entry.progress = 0; }
        else this.active.set(event.model, { model: event.model, phase: 'prefill', progress: 0, startedAt: at, lastEventAt: at, requests: 1, streamed: 0 });
        this.recentModel = event.model;
        return;
      }
      case 'streaming': {
        const entry = this.active.get(event.model);
        if (entry && entry.streamed < entry.requests) { entry.streamed += 1; entry.lastEventAt = at; }
        return;
      }
      case 'prediction': {
        // Only a request that never announced streaming ends here; streamed ones end at "Finished streaming response".
        const entry = this.active.get(event.model);
        if (!entry || entry.requests <= entry.streamed) return;
        entry.requests -= 1;
        if (entry.requests <= 0) this.active.delete(entry.model);
        return;
      }
      case 'prefill': {
        const entry = this.active.get(event.model);
        if (!entry) return;
        entry.lastEventAt = at;
        if (event.progress >= 1) { entry.phase = 'decode'; entry.progress = null; }
        else { entry.phase = 'prefill'; entry.progress = event.progress; }
        this.recentModel = event.model;
        return;
      }
      case 'done': {
        // The completion summary carries no model tag; attribute it only when exactly one request is in flight.
        const inFlight = [...this.active.values()].reduce((sum, entry) => sum + entry.requests, 0);
        const owner = inFlight === 1 ? [...this.active.keys()][0] ?? null : inFlight === 0 ? this.recentModel : null;
        this.last = { model: owner, tokensPerSecond: event.tokensPerSecond, ttftSeconds: event.ttftSeconds,
          promptTokens: event.promptTokens, cachedTokens: event.cachedTokens, outputTokens: event.outputTokens, finishedAt: at };
        this.completed += 1;
        if (event.outputTokens !== null && event.tokensPerSecond !== null && event.tokensPerSecond > 0) {
          this.outputTokens += event.outputTokens;
          this.decodeSeconds += event.outputTokens / event.tokensPerSecond;
        }
        if (event.promptTokens !== null && event.cachedTokens !== null && event.cachedTokens <= event.promptTokens) {
          this.promptTokens += event.promptTokens;
          this.cachedTokens += event.cachedTokens;
        }
        return;
      }
      case 'finished':
      case 'failed': {
        const model = event.model ?? this.recentModel;
        const entry = model ? this.active.get(model) : undefined;
        if (!entry) return;
        entry.requests -= 1;
        if (event.kind === 'finished' && entry.streamed > 0) entry.streamed -= 1;
        entry.streamed = Math.min(entry.streamed, entry.requests);
        if (entry.requests <= 0) this.active.delete(entry.model);
        return;
      }
    }
  }

  /** Stream restarts can drop events; never keep a request that can no longer be observed. */
  resetActive(): void { this.active.clear(); }
  /** A new stream or another connection: counts and averages from before may have missed lines, so they start again. */
  reset(): void {
    this.active.clear(); this.recentModel = null; this.last = null;
    this.completed = 0; this.outputTokens = 0; this.decodeSeconds = 0; this.promptTokens = 0; this.cachedTokens = 0;
  }

  view(): LMStudioActivityView {
    const at = this.now();
    for (const [key, entry] of this.active) if (at - entry.lastEventAt > ABANDONED_MS) this.active.delete(key);
    let current: Active | null = null;
    let activeRequests = 0;
    for (const entry of this.active.values()) {
      activeRequests += entry.requests;
      current = entry;
    }
    const concurrent = activeRequests > 1;
    return {
      active: current && !concurrent
        ? { model: current.model, phase: current.phase, progress: current.progress, startedAt: current.startedAt, requests: current.requests } : null,
      concurrent,
      activeRequests,
      lastRequest: this.last,
      completedRequests: this.completed,
      averageDecodeTPS: this.decodeSeconds > 0 ? this.outputTokens / this.decodeSeconds : null,
      cacheEfficiencyPercent: this.promptTokens > 0 ? this.cachedTokens / this.promptTokens * 100 : null,
    };
  }
}

/** Longest log record kept. Lifecycle lines are well under 1 KB; longer records are discarded unread. */
export const MAX_LOG_LINE_BYTES = 16 * 1024;

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

type StreamProcess = ChildProcessByStdio<null, Readable, Readable>;
type Spawner = (file: string, args: string[], env: NodeJS.ProcessEnv) => StreamProcess;
type StreamOptions = {
  lmsPath?: string | null; home?: string; spawnStream?: Spawner; now?: () => number; idleStopMs?: number; restartBaseMs?: number;
};
export type ActivitySource = { touch(): void; view(): LMStudioActivityView | null };

/** Small local JSON/text files only; anything missing, oversized or malformed reads as absent. */
const readSmall = (file: string, limit = 64 * 1024): string | null => {
  try { return statSync(file).size <= limit ? readFileSync(file, 'utf8') : null; } catch { return null; }
};
const filePort = (file: string): number | null => {
  try {
    const port = (JSON.parse(readSmall(file) ?? 'null') as { port?: unknown } | null)?.port;
    return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
  } catch { return null; }
};

/** The LM Studio home, resolved the way lms resolves it: the home pointer, then the legacy cache home, then ~/.lmstudio. */
export const findLMStudioHome = (home = homedir()): string => {
  const pointer = readSmall(path.join(home, '.lmstudio-home-pointer'), 4096)?.trim();
  if (pointer && path.isAbsolute(pointer)) return pointer;
  const legacy = path.join(home, '.cache', 'lm-studio');
  return existsSync(legacy) ? legacy : path.join(home, '.lmstudio');
};

export const findLms = (home = homedir()): string | null => {
  const candidates = [findLMStudioHome(home), path.join(home, '.lmstudio'), path.join(home, '.cache', 'lm-studio')]
    .map(root => path.join(root, 'bin', 'lms'));
  return [...new Set(candidates)].find(candidate => existsSync(candidate)) ?? null;
};

/** Where the running LM Studio or Bionic records its internal API port. Absent or portless while the app is not running. */
export const lmsServerInfoPath = (lmstudioHome: string): string => path.join(lmstudioHome, '.internal', 'http-server.json');
/** The REST server settings of that LM Studio home; its `port` is the loopback port OpenChamber connects to. */
const restConfigPath = (lmstudioHome: string): string => path.join(lmstudioHome, '.internal', 'http-server-config.json');

export const defaultSpawner: Spawner = (file, args, env) => spawn(file, args, {
  shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
});

const SILENT_EXIT_LIMIT = 5;
/** lms log stream's first line (to stderr); stdout is pure NDJSON after it. */
const BANNER = /Streaming logs from LM Studio/;

/**
 * Runs `lms log stream -s server --json --port <port>` only while MLX Scope is being watched and the LM Studio server
 * of the local LM Studio home has just answered. The explicit port and server-info path make lms connect to that
 * already-running app; without them lms launches LM Studio or Bionic when none is running.
 */
export class LMStudioActivityStream {
  readonly tracker: LMStudioActivityTracker;
  private child: StreamProcess | null = null;
  private healthy = false;
  private failures = 0;
  private silentExits = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Counts successful reads from the home server; a stream that ended restarts only after a newer one. */
  private reads = 0;
  private readsAtEnd = 0;
  private restPort: { value: number | null; at: number } | null = null;
  private readonly lms: string | null;
  private readonly lmstudioHome: string;
  private readonly spawnStream: Spawner;
  private readonly idleStopMs: number;
  private readonly restartBaseMs: number;
  private readonly now: () => number;

  constructor(options: StreamOptions = {}) {
    const home = options.home ?? homedir();
    this.lmstudioHome = findLMStudioHome(home);
    this.lms = options.lmsPath === undefined ? findLms(home) : options.lmsPath;
    this.spawnStream = options.spawnStream ?? defaultSpawner;
    this.idleStopMs = options.idleStopMs ?? 60_000;
    this.restartBaseMs = options.restartBaseMs ?? 1000;
    this.now = options.now ?? Date.now;
    this.tracker = new LMStudioActivityTracker(this.now);
  }

  get available(): boolean { return this.lms !== null; }

  /** The view for one connection. Only the connection on the home server's REST port starts or sees the stream. */
  forPort(port: number | null): ActivitySource {
    return { touch: () => { if (this.servesPort(port)) this.touch(); }, view: () => this.servesPort(port) ? this.view() : null };
  }

  private servesPort(port: number | null): boolean {
    const now = this.now();
    if (!this.restPort || now - this.restPort.at > 10_000) {
      const value = filePort(restConfigPath(this.lmstudioHome));
      // The home server moved to another port: the stream now belongs to another connection.
      if (this.restPort && value !== this.restPort.value) this.tracker.reset();
      this.restPort = { value, at: now };
    }
    return port !== null && this.restPort.value !== null && port === this.restPort.value;
  }

  /**
   * Call only after a successful read from the home LM Studio server. Starts the stream if needed and extends its
   * demand window. A runtime that stopped answering is never restarted by MLX Scope.
   */
  touch(): void {
    if (!this.lms) return;
    this.reads += 1;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.idleStopMs);
    this.idleTimer.unref?.();
    if (!this.child && !this.restartTimer && this.silentExits < SILENT_EXIT_LIMIT) this.start();
  }

  view(): LMStudioActivityView | null { return this.healthy ? this.tracker.view() : null; }

  stop(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const child = this.child;
    this.child = null;
    this.healthy = false;
    this.silentExits = 0;
    this.tracker.resetActive();
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM'); } catch { /* Already exited. */ }
    }
  }

  private start(): void {
    const lms = this.lms!;
    const infoPath = lmsServerInfoPath(this.lmstudioHome);
    // No recorded port means the app is not running: never ask lms to find (and so start) it.
    const port = filePort(infoPath);
    if (port === null) return;
    let child: StreamProcess;
    let connected = false;
    try {
      child = this.spawnStream(lms, ['log', 'stream', '-s', 'server', '--json', '--port', String(port)], {
        LANG: 'C', LC_ALL: 'C', HOME: homedir(), PATH: '/usr/bin:/bin', LMS_API_SERVER_INFO_PATH: infoPath,
      });
    } catch { this.readsAtEnd = this.reads; this.scheduleRestart(); return; }
    this.child = child;
    this.tracker.reset();
    // Healthy only once lms says it is streaming (its banner, normally on stderr) or a JSON record arrives: an lms that
    // prints only an error never counts as connected, and its exit counts as silent.
    const ready = () => { if (this.child !== child || this.healthy) return; connected = true; this.healthy = true; this.failures = 0; this.silentExits = 0; };
    const lines = new BoundedLines(line => {
      if (this.child !== child) return;
      if (BANNER.test(line)) { ready(); return; }
      if (!line.startsWith('{')) return;
      let record: unknown;
      try { record = JSON.parse(line); } catch { return; }
      if (!record || typeof record !== 'object' || Array.isArray(record)) return;
      ready();
      const data = (record as { data?: unknown }).data;
      const content = data && typeof data === 'object' ? (data as { content?: unknown }).content : null;
      if (typeof content !== 'string') return;
      const event = parseLMStudioServerLine(content);
      if (event) this.tracker.apply(event);
    });
    const errors = new BoundedLines(line => { if (BANNER.test(line)) ready(); });
    child.stdout.on('data', (chunk: Buffer) => lines.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    const ended = () => {
      if (this.child !== child) return;
      this.child = null;
      this.healthy = false;
      this.tracker.resetActive();
      lines.reset(); errors.reset();
      this.readsAtEnd = this.reads;
      if (!connected) this.silentExits += 1;
      // lms that exits without output keeps failing to connect; stop retrying until Scope is reopened.
      if (this.idleTimer && this.silentExits < SILENT_EXIT_LIMIT) this.scheduleRestart();
    };
    child.once('exit', ended);
    child.once('error', ended);
  }

  private scheduleRestart(): void {
    this.failures = Math.min(6, this.failures + 1);
    const delay = Math.min(30 * this.restartBaseMs, this.restartBaseMs * 2 ** (this.failures - 1));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      // Otherwise the next successful read restarts it through touch().
      if (this.idleTimer && this.reads > this.readsAtEnd) this.start();
    }, delay);
    this.restartTimer.unref?.();
  }
}
