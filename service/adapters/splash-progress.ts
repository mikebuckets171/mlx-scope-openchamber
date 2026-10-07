import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { count, nonneg, obj, type Json } from '../../src/contract/guards.ts';

// Private, read-only companion transport. Nothing here polls, writes, executes commands, or returns an identity
// to a guest. A /status read supplies the independent evidence that the matching request can still be prefilling.
export const PROGRESS_TTL_MS = 15_000;
export const PROGRESS_MAX_WRITERS = 16;
export const PROGRESS_MAX_ENTRIES = 16;
export const PROGRESS_MAX_BYTES = 65_536;
const CONTINUITY_MS = 5_000;
const STALL_MS = 6_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const KINDS = ['primary', 'compaction', 'title', 'generate'];
const ENVELOPE_KEYS = ['schemaVersion', 'writerID', 'updatedAtMs', 'expiresAtMs', 'entries'];
const ENTRY_KEYS = ['requestID', 'sessionKey', 'providerID', 'endpointKey', 'modelKey', 'responseModelKey', 'kind',
  'total', 'cache', 'processed', 'timeMs', 'observedAtMs', 'expiresAtMs'];

export const progressKey = (kind: 'session' | 'endpoint' | 'model', value: string): string =>
  createHash('sha256').update(`mlx-scope-${kind}-v1\0${value}`).digest('hex');

interface ProgressEntry {
  writerID: string; requestID: string; sessionKey: string; providerID: string; endpointKey: string;
  modelKey: string; responseModelKey?: string; kind: string;
  total: number; cache: number; processed: number; timeMs: number; observedAtMs: number; expiresAtMs: number;
}
export interface ProgressScope {
  providerID: string; endpointOrigin: string; model: string; generationKey: string; startedAtMs?: number;
}
export interface ProgressReading {
  processed: number; total: number; observedAt: number; stale: boolean;
}
export interface ProgressOptions { home?: string; uid?: number }
const exactKeys = (item: Json, allowed: readonly string[]): boolean => Object.keys(item).every(key => allowed.includes(key));
const string = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);
const timestamp = (value: unknown): number | null => { const n = count(value); return n !== null && n <= 8.64e15 ? n : null; };
const liveTime = (observed: number | null, expires: number | null, at: number): boolean => observed !== null && expires !== null
  && observed <= at && expires > at && expires > observed && expires - observed <= PROGRESS_TTL_MS;

/** Version 1 is a closed allowlist. Unknown formats cannot establish that a competing request is absent. */
export const parseProgressFile = (source: string, writerID: string, at: number): ProgressEntry[] | null => {
  let body: Json | null;
  try { body = obj(JSON.parse(source)); } catch { return null; }
  if (!body || !exactKeys(body, ENVELOPE_KEYS) || body.schemaVersion !== 1 || body.writerID !== writerID || !UUID.test(writerID)
    || !Array.isArray(body.entries) || body.entries.length > PROGRESS_MAX_ENTRIES) return null;
  const updated = timestamp(body.updatedAtMs), expires = timestamp(body.expiresAtMs);
  if (updated === null || expires === null || updated > at || expires <= updated || expires - updated > PROGRESS_TTL_MS) return null;
  const entries: ProgressEntry[] = [], seen = new Set<string>();
  for (const value of body.entries) {
    const item = obj(value);
    if (!item || !exactKeys(item, ENTRY_KEYS) || !string(item.requestID, UUID) || seen.has(item.requestID)
      || !string(item.sessionKey, HASH) || !string(item.endpointKey, HASH) || !string(item.modelKey, HASH)
      || item.responseModelKey !== undefined && !string(item.responseModelKey, HASH)
      || !string(item.providerID, /^[a-zA-Z0-9_-]{1,80}$/) || !KINDS.includes(item.kind as string)) return null;
    const total = count(item.total), cache = count(item.cache), processed = count(item.processed), timeMs = nonneg(item.timeMs);
    const observed = timestamp(item.observedAtMs), entryExpires = timestamp(item.expiresAtMs);
    if (total === null || total === 0 || cache === null || processed === null || cache > processed || processed > total || timeMs === null
      || observed === null || entryExpires === null || observed > updated || entryExpires <= observed
      || entryExpires - observed > PROGRESS_TTL_MS || entryExpires > expires) return null;
    seen.add(item.requestID);
    if (expires > at && liveTime(observed, entryExpires, at)) entries.push({ writerID, requestID: item.requestID,
      sessionKey: item.sessionKey, providerID: item.providerID, endpointKey: item.endpointKey, modelKey: item.modelKey,
      ...item.responseModelKey !== undefined ? { responseModelKey: item.responseModelKey as string } : {}, kind: item.kind as string,
      total, cache, processed, timeMs, observedAtMs: observed, expiresAtMs: entryExpires });
  }
  return entries;
};

/** Checks each cache ancestor, without making an unsafe shared ancestor such as ~/.cache into a private directory. */
const safeDirectory = async (home: string, uid: number): Promise<{ path: string; dev: number; ino: number } | null> => {
  const base = await lstat(home);
  if (!base.isDirectory() || base.isSymbolicLink() || base.uid !== uid || base.mode & 0o022) return null;
  let path = home;
  for (const part of ['.cache', 'mlx-scope', 'prompt-progress']) {
    path = join(path, part);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || info.mode & 0o022) return null;
    if (part === 'prompt-progress') {
      if ((info.mode & 0o777) !== 0o700) return null;
      return { path, dev: info.dev, ino: info.ino };
    }
  }
  return null;
};

/** A bounded fd read avoids following a link, opening a FIFO, or growing an allocation after the size check. */
const readWriter = async (path: string, uid: number): Promise<string | null> => {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid || (before.mode & 0o777) !== 0o600
    || before.nlink !== 1 || before.size <= 0 || before.size > PROGRESS_MAX_BYTES) return null;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600 || info.nlink !== 1
      || info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size) return null;
    const bytes = Buffer.alloc(PROGRESS_MAX_BYTES + 1), read = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat(), named = await lstat(path);
    if (read.bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs
      || named.dev !== info.dev || named.ino !== info.ino) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead));
  } finally { await handle.close(); }
};

export const readProgressCache = async (at: number, options: ProgressOptions = {}): Promise<ProgressEntry[] | null> => {
  const home = options.home ?? homedir(), uid = options.uid ?? process.getuid?.();
  if (uid === undefined || timestamp(at) === null) return null;
  try {
    const directory = await safeDirectory(home, uid);
    if (!directory) return null;
    const files: string[] = [], scan = await opendir(directory.path, { bufferSize: PROGRESS_MAX_WRITERS + 1 });
    let scanned = 0;
    for await (const item of scan) {
      if (++scanned > PROGRESS_MAX_WRITERS * 2) return null;
      // A writer's short-lived atomic temporary file is not an observation.
      if (item.isFile() && item.name.length === 78 && item.name.startsWith('.') && item.name.endsWith('.tmp')
        && UUID.test(item.name.slice(1, 37)) && UUID.test(item.name.slice(38, -4)) && item.name[37] === '-') continue;
      if (!item.isFile() || !item.name.endsWith('.json') || !UUID.test(item.name.slice(0, -5))) return null;
      files.push(item.name);
      if (files.length > PROGRESS_MAX_WRITERS) return null;
    }
    const entries: ProgressEntry[] = [], seen = new Set<string>();
    for (const name of files) {
      const source = await readWriter(join(directory.path, name), uid);
      const parsed = source === null ? null : parseProgressFile(source, name.slice(0, -5), at);
      if (!parsed) return null;
      for (const item of parsed) {
        if (seen.has(item.requestID)) return null;
        seen.add(item.requestID); entries.push(item);
      }
    }
    const after = await safeDirectory(home, uid);
    return after?.dev === directory.dev && after.ino === directory.ino ? entries : null;
  } catch { return null; }
};

/** Private continuity state is independent of both throughput windows and never identifies a chat. */
export class SplashPromptProgress {
  private anchor: ProgressEntry | null = null;
  private generation: string | null = null;
  private boundary = -1;
  private lastAt: number | null = null;
  private sequence = 0;
  constructor(private readonly options: ProgressOptions = {}) {}

  async observe(scope: ProgressScope | null, at: number, monotonicAt: number): Promise<ProgressReading | undefined> {
    if (!scope || timestamp(at) === null || nonneg(monotonicAt) === null
      || this.lastAt !== null && (monotonicAt <= this.lastAt || monotonicAt - this.lastAt > CONTINUITY_MS)) {
      this.reset(at); return undefined;
    }
    if (this.generation !== null && scope.generationKey !== this.generation) this.reset(at);
    this.generation = scope.generationKey; this.lastAt = monotonicAt;
    const sequence = ++this.sequence, entries = await readProgressCache(at, this.options);
    if (sequence !== this.sequence) return undefined;
    const endpoint = progressKey('endpoint', scope.endpointOrigin), model = progressKey('model', scope.model);
    const matching = entries?.filter(entry => entry.providerID === scope.providerID && entry.endpointKey === endpoint
      && (entry.modelKey === model || entry.responseModelKey === model));
    if (!matching || matching.length !== 1) { this.reset(at); return undefined; }
    const current = matching[0]!;
    if (current.kind !== 'primary') { this.reset(at); return undefined; }
    if (current.observedAtMs <= this.boundary || current.observedAtMs < (scope.startedAtMs ?? 0)) { this.anchor = null; return undefined; }
    const previous = this.anchor;
    if (previous?.requestID === current.requestID && (current.writerID !== previous.writerID || current.sessionKey !== previous.sessionKey
      || current.total !== previous.total || current.cache !== previous.cache || current.observedAtMs < previous.observedAtMs
      || current.processed < previous.processed || current.timeMs < previous.timeMs)) { this.reset(at); return undefined; }
    this.anchor = current;
    return { processed: current.processed, total: current.total, observedAt: current.observedAtMs,
      stale: at - current.observedAtMs >= STALL_MS };
  }

  reset(at: number): void {
    this.sequence += 1; this.anchor = null; this.generation = null; this.lastAt = null;
    if (timestamp(at) !== null) this.boundary = Math.max(this.boundary, at);
  }
}
