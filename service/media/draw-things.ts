import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { chatKey } from '../../src/contract/chat-key.ts';
import { defined } from '../../src/contract/guards.ts';
import { parseMediaProgress, type MediaJobV1, type MediaPhase, type MediaSourceV1 } from '../../src/contract/media.ts';
import { lsofDrawThingsArgv, processId, type Exec } from '../lib/argv.ts';
import type { MediaCollection } from './adapters.ts';
import type { MediaSourceConfig } from './discovery.ts';

// Draw Things' command-line tool (draw-things-cli) prints its progress to its output: "Starting...", "Processing...",
// "Sampling... 8 / 25", "Finishing...", "Generated", then "Wrote: <file>". It has no status endpoint, so Scope finds running
// renders with lsof (the file each one writes its output to) and reads the end of that file. Only the phase, the step
// counters, the file's times and whether it finished are kept; process ids and paths stay in service memory, and prompts,
// settings, paths and outputs never leave it. Observe-only: Scope cannot start, stop or change a render. Renders started
// inside the Draw Things app, or whose output goes to a terminal, are not visible.

/** Reads while a render runs, and while none is seen. */
export const DRAW_THINGS_READ_MS = { active: 15_000, idle: 30_000 } as const;
export const DRAW_THINGS_STALE_MS = 37_500;
const TAIL_BYTES = 64 * 1024, TERMINAL_LIMIT = 8, RETENTION_MS = 86_400_000;
const PHASES: Readonly<Record<string, MediaPhase>> = { Starting: 'preparing', Processing: 'preparing', Sampling: 'sampling', Finishing: 'finishing', Generated: 'finishing' };

export interface DrawThingsLog { phase: MediaPhase; step: number | null; total: number | null; passes: number; generated: boolean; kind: MediaJobV1['kind'] }
/** The newest progress line of a log, how many sampling passes it began, and whether it finished. Nothing else is read. */
export const parseDrawThingsLog = (text: string): DrawThingsLog | null => {
  let phase: MediaPhase | null = null, step: number | null = null, total: number | null = null, passes = 0, previous = Infinity, generated = false;
  let kind: MediaJobV1['kind'] = 'unknown';
  // Progress lines rewrite themselves with carriage returns and terminal escapes.
  for (const raw of text.split(/[\r\n]+/)) {
    const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
    const sampling = /^Sampling\.\.\. (\d{1,6}) \/ (\d{1,6})\b/.exec(line);
    if (sampling) {
      const value = Number(sampling[1]), of = Number(sampling[2]);
      if (value <= previous) passes++;
      previous = value; phase = 'sampling'; step = value; total = of; continue;
    }
    const named = /^(Starting|Processing|Finishing)\.\.\.|^(Generated)\b/.exec(line);
    if (named) { phase = PHASES[named[1] ?? named[2]!]!; step = total = null; if (named[2]) generated = true; continue; }
    const wrote = /^Wrote: .*\.(png|jpe?g|mov|mp4)$/i.exec(line);
    if (wrote) { generated = true; kind = /png|jpe?g/i.test(wrote[1]!) ? 'image' : 'video'; }
  }
  return phase === null ? null : { phase, step, total, passes, generated, kind };
};

/** `lsof -Fpn` for draw-things-cli's output: each process id with the absolute regular path of its standard output. */
export const parseDrawThingsLsof = (output: string | null): Map<number, string> => {
  const found = new Map<number, string>();
  let pid: number | null = null;
  for (const line of (output ?? '').split('\n')) {
    if (line.startsWith('p')) pid = processId(Number(line.slice(1)));
    else if (line.startsWith('n') && pid !== null && !found.has(pid) && isAbsolute(line.slice(1)) && !/[\u0000-\u001f]/.test(line)) found.set(pid, line.slice(1));
  }
  return found;
};

const readTail = async (file: string): Promise<{ text: string; modifiedAtMs: number; createdAtMs: number } | null> => {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) return null;
      const length = Math.min(info.size, TAIL_BYTES), bytes = Buffer.alloc(length);
      const { bytesRead } = await handle.read(bytes, 0, length, info.size - length);
      return { text: bytes.subarray(0, bytesRead).toString('utf8'), modifiedAtMs: info.mtimeMs, createdAtMs: info.birthtimeMs || info.ctimeMs };
    } finally { await handle.close(); }
  } catch { return null; }
};

interface Seen { id: string; file: string; missing: number; job: MediaJobV1 }
/** Renders seen running, per source: Scope lists only what it watched, and keeps the last few that ended. */
const watched = new Map<string, { running: Map<number, Seen>; ended: MediaJobV1[] }>();

export const drawThings = async (config: MediaSourceConfig, options: { now: () => number; exec?: Exec }): Promise<MediaCollection> => {
  if (!options.exec) throw new Error('Draw Things needs the host process probe');
  const now = options.now(), state = watched.get(config.id) ?? { running: new Map<number, Seen>(), ended: [] };
  watched.set(config.id, state);
  // lsof exits non-zero when no render is running; a probe that fails outright looks the same, so an unseen render
  // must also be missing from a second read before it is called ended.
  const running = parseDrawThingsLsof(await options.exec(lsofDrawThingsArgv()));
  const source: MediaSourceV1 = { id: config.id, kind: 'draw-things', label: config.label, state: 'ready', capabilities: { progress: false, cancel: false } };
  const jobs: MediaJobV1[] = [];
  for (const [pid, file] of running) {
    const previous = state.running.get(pid), same = previous?.file === file;
    const id = same ? previous.id : `dt-${chatKey('model', `${pid}\0${file}\0${now}`).slice(0, 12)}`;
    const tail = await readTail(file), log = tail ? parseDrawThingsLog(tail.text) : null;
    const counters = log?.phase === 'sampling' ? parseMediaProgress({ basis: 'phase', value: log.step, total: log.total, unit: 'steps' }) : null;
    const job: MediaJobV1 = {
      id, sourceId: config.id, kind: log?.kind ?? 'unknown', name: `Render ${id.slice(-6)}`, state: 'running', phase: log?.phase ?? 'unknown',
      progress: counters, sampledAtMs: now, observedAtMs: now, freshness: 'live', ownership: {}, cancel: { supported: false },
      ...tail ? { startedAtMs: Math.min(tail.createdAtMs, now) } : {},
      // The file changes with each printed step, so its modification time is when this count was reported.
      ...counters && tail ? { progressAtMs: Math.min(tail.modifiedAtMs, now) } : {},
      ...counters && log!.passes > 1 ? { phaseKey: chatKey('model', `${id}\0pass ${log!.passes}`) } : {},
    };
    if (counters) source.capabilities.progress = true;
    state.running.set(pid, { id, file, missing: 0, job });
    jobs.push(job);
  }
  for (const [pid, seen] of state.running) {
    if (running.has(pid)) continue;
    if (++seen.missing < 2) { jobs.push({ ...seen.job, sampledAtMs: now }); continue; }
    state.running.delete(pid);
    const tail = await readTail(seen.file), log = tail ? parseDrawThingsLog(tail.text) : null, finished = tail ? Math.min(tail.modifiedAtMs, now) : now;
    const done = log?.generated === true;
    state.ended.unshift({ ...seen.job, kind: log?.kind ?? seen.job.kind, state: done ? 'completed' : 'failed', phase: done ? 'completed' : 'failed', progress: null,
      sampledAtMs: now, observedAtMs: finished, finishedAtMs: finished, freshness: 'last', progressAtMs: undefined, phaseKey: undefined,
      ...done ? {} : { message: 'Ended before finishing; Draw Things printed no error.' } });
  }
  state.ended = state.ended.filter(job => now - (job.finishedAtMs ?? now) <= RETENTION_MS).slice(0, TERMINAL_LIMIT);
  jobs.push(...state.ended.map(job => ({ ...job, sampledAtMs: now })));
  const active = state.running.size > 0;
  return { source, jobs: jobs.map(job => defined(job)),
    staleMs: DRAW_THINGS_STALE_MS, ttlMs: active ? DRAW_THINGS_READ_MS.active : DRAW_THINGS_READ_MS.idle };
};
