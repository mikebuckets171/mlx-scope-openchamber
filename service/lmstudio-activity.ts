import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

/** One recognised line of LM Studio's redacted server log. Prompt and output text are never read. */
export type LMStudioLogEvent =
  | { kind: 'request'; model: string }
  | { kind: 'prefill'; model: string; progress: number }
  | { kind: 'done'; promptTokens: number | null; cachedTokens: number | null; outputTokens: number | null;
      ttftSeconds: number | null; tokensPerSecond: number | null }
  | { kind: 'finished'; model: string }
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
  active: { model: string; phase: 'prefill' | 'decode'; progress: number | null; startedAt: number; requests: number } | null;
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
const cleanModel = (value: string | undefined): string | null => {
  const clean = value?.replace(/[\u0000-\u001f\u007f]/g, '').trim();
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
  if (/^Finished (?:streaming response|generating|prediction)/i.test(rest)) return model ? { kind: 'finished', model } : null;
  if (level === 'ERROR' && model) return { kind: 'failed', model };
  return null;
}

type Active = { model: string; phase: 'prefill' | 'decode'; progress: number | null; startedAt: number; lastEventAt: number; requests: number };
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
        else this.active.set(event.model, { model: event.model, phase: 'prefill', progress: 0, startedAt: at, lastEventAt: at, requests: 1 });
        this.recentModel = event.model;
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
        this.last = { model: this.recentModel, tokensPerSecond: event.tokensPerSecond, ttftSeconds: event.ttftSeconds,
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
        if (entry.requests <= 0) this.active.delete(entry.model);
        return;
      }
    }
  }

  /** Stream restarts can drop events; never keep a request that can no longer be observed. */
  resetActive(): void { this.active.clear(); }

  view(): LMStudioActivityView {
    const at = this.now();
    for (const [key, entry] of this.active) if (at - entry.lastEventAt > ABANDONED_MS) this.active.delete(key);
    let current: Active | null = null;
    let activeRequests = 0;
    for (const entry of this.active.values()) {
      activeRequests += entry.requests;
      if (!current || entry.startedAt > current.startedAt) current = entry;
    }
    return {
      active: current ? { model: current.model, phase: current.phase, progress: current.progress, startedAt: current.startedAt, requests: current.requests } : null,
      activeRequests,
      lastRequest: this.last,
      completedRequests: this.completed,
      averageDecodeTPS: this.decodeSeconds > 0 ? this.outputTokens / this.decodeSeconds : null,
      cacheEfficiencyPercent: this.promptTokens > 0 ? this.cachedTokens / this.promptTokens * 100 : null,
    };
  }
}

type StreamProcess = ChildProcessByStdio<null, Readable, Readable>;
type Spawner = (file: string, args: string[]) => StreamProcess;
type StreamOptions = { lmsPath?: string | null; spawnStream?: Spawner; now?: () => number; idleStopMs?: number };

export const findLms = (home = homedir()): string | null => {
  for (const candidate of [path.join(home, '.lmstudio', 'bin', 'lms'), path.join(home, '.cache', 'lm-studio', 'bin', 'lms')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

const defaultSpawner: Spawner = (file, args) => spawn(file, args, {
  shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { LANG: 'C', LC_ALL: 'C', HOME: homedir(), PATH: '/usr/bin:/bin' },
});

/** Runs `lms log stream -s server --json` only while MLX Scope is being watched. */
export class LMStudioActivityStream {
  readonly tracker: LMStudioActivityTracker;
  private child: StreamProcess | null = null;
  private healthy = false;
  private failures = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly lms: string | null;
  private readonly spawnStream: Spawner;
  private readonly idleStopMs: number;

  constructor(options: StreamOptions = {}) {
    this.lms = options.lmsPath === undefined ? findLms() : options.lmsPath;
    this.spawnStream = options.spawnStream ?? defaultSpawner;
    this.idleStopMs = options.idleStopMs ?? 60_000;
    this.tracker = new LMStudioActivityTracker(options.now);
  }

  get available(): boolean { return this.lms !== null; }

  /** Call on every snapshot read. Starts the stream if needed and extends its demand window. */
  touch(): void {
    if (!this.lms) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.idleStopMs);
    this.idleTimer.unref?.();
    if (!this.child && !this.restartTimer) this.start();
  }

  view(): LMStudioActivityView | null { return this.healthy ? this.tracker.view() : null; }

  stop(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const child = this.child;
    this.child = null;
    this.healthy = false;
    this.tracker.resetActive();
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM'); } catch { /* Already exited. */ }
    }
  }

  private start(): void {
    let child: StreamProcess;
    try { child = this.spawnStream(this.lms!, ['log', 'stream', '-s', 'server', '--json']); }
    catch { this.scheduleRestart(); return; }
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (this.child !== child) return;
      if (!this.healthy) { this.healthy = true; this.failures = 0; }
      if (!line.startsWith('{')) return;
      let record: unknown;
      try { record = JSON.parse(line); } catch { return; }
      const data = record && typeof record === 'object' ? (record as { data?: unknown }).data : null;
      const content = data && typeof data === 'object' ? (data as { content?: unknown }).content : null;
      if (typeof content !== 'string') return;
      const event = parseLMStudioServerLine(content);
      if (event) this.tracker.apply(event);
    });
    child.stderr.resume();
    const ended = () => {
      if (this.child !== child) return;
      this.child = null;
      this.healthy = false;
      this.tracker.resetActive();
      lines.close();
      if (this.idleTimer) this.scheduleRestart();
    };
    child.once('exit', ended);
    child.once('error', ended);
  }

  private scheduleRestart(): void {
    this.failures = Math.min(6, this.failures + 1);
    const delay = Math.min(30_000, 1000 * 2 ** (this.failures - 1));
    this.restartTimer = setTimeout(() => { this.restartTimer = null; if (this.idleTimer) this.start(); }, delay);
    this.restartTimer.unref?.();
  }
}
