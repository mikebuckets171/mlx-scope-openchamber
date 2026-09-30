import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { CompletionDraft } from '../core/adapter-v2.ts';
import {
  ActivityTracker, BoundedLines, createConnectionActivity, MAX_LOG_LINE_BYTES, parseServerRecord, type ServerLineEvent, type StreamSpawn,
} from './lmstudio-activity.ts';

const FIXTURES = path.join(import.meta.dir, '../../tests/fixtures/lmstudio/bionic-1.1.6');
const lines = (name: string) => readFileSync(path.join(FIXTURES, `lms-log-stream-server.${name}.txt`), 'utf8').split('\n').filter(Boolean);
const CANARY = /CANARY-(?:PROMPT|OUTPUT)-7f3a/;
const MODEL = 'publisher/example-27b-splash';
const record = (content: string, level = 'info') => JSON.stringify({ timestamp: 1, data: { type: 'server.log', content, level } });
const parse = (line: string) => parseServerRecord(line, 5_000);
/** Every line through the 16 KiB reader, then the parser: what the stream sees. */
const stream = (text: string, at = () => 5_000): ServerLineEvent[] => {
  const events: ServerLineEvent[] = [];
  const reader = new BoundedLines(line => { const event = parseServerRecord(line, at()); if (event) events.push(event); });
  reader.push(Buffer.from(text));
  return events;
};
const doneOf = (fields: Partial<CompletionDraft>): ServerLineEvent => ({ kind: 'done', completion: { finishedAt: 5_000, startedAt: null, model: null,
  basis: 'reported', overlapped: false, ...fields } });

test('a redacted streaming request: start, prompt progress, the Splash summary, finish', () => {
  expect(lines('lifecycle').map(parse)).toEqual([
    null,                                                         // Received request … [Sensitive]
    { kind: 'started', model: MODEL }, { kind: 'streaming', model: MODEL },
    { kind: 'progress', model: MODEL, fraction: 0 }, { kind: 'progress', model: MODEL, fraction: 0.375 }, { kind: 'progress', model: MODEL, fraction: 1 },
    doneOf({ promptTokens: 1_536, cachedTokens: 1_024, outputTokens: 812, ttftMs: 1_800, decodeTps: 64.2 }),
    { kind: 'finished', model: MODEL, prediction: false },
  ]);
});

test('a non-streaming request ends at "Generated prediction"; tool-call lines carry nothing', () => {
  expect(lines('non-streaming').map(parse)).toEqual([
    null, { kind: 'started', model: MODEL }, { kind: 'progress', model: MODEL, fraction: 0.189 }, { kind: 'progress', model: MODEL, fraction: 1 },
    doneOf({ promptTokens: 214, cachedTokens: 0, outputTokens: 96, ttftMs: 600, decodeTps: 58.1 }), null,
    { kind: 'finished', model: MODEL, prediction: true },
  ]);
});

test('request bodies, per-token text, the spoofed summary and oversized records are dropped', () => {
  for (const name of ['drop-request-body', 'drop-incoming-tokens', 'drop-oversized']) {
    for (const line of lines(name)) expect(parse(line), name).toBeNull();
    expect(stream(lines(name).join('\n') + '\n'), name).toEqual([]);
  }
  // The oversized record never reaches the parser at all: the reader discards it unread.
  const seen: string[] = [];
  new BoundedLines(line => seen.push(line)).push(Buffer.from(`${lines('drop-oversized')[0]}\n${record('after')}\n`));
  expect(lines('drop-oversized')[0]!.length).toBeGreaterThan(MAX_LOG_LINE_BYTES);
  expect(seen).toEqual([record('after')]);
});

test('with logSensitiveData and logIncomingTokens on, the events equal a redacted run and no canary gets through', () => {
  const all = lines('sensitive-on'), clean = all.filter(line => !CANARY.test(line));
  const events = stream(all.join('\n') + '\n');
  expect(events).toEqual(stream(clean.join('\n') + '\n'));
  expect(events).toEqual([
    { kind: 'started', model: MODEL }, { kind: 'streaming', model: MODEL }, { kind: 'progress', model: MODEL, fraction: 0 },
    { kind: 'progress', model: MODEL, fraction: 1 }, doneOf({ promptTokens: 640, cachedTokens: 0, outputTokens: 1_050, ttftMs: 900, decodeTps: 79.6 }),
    { kind: 'finished', model: MODEL, prediction: false },
  ]);
  const tracker = new ActivityTracker(() => 5_000);
  for (const event of events) tracker.apply(event);
  expect(JSON.stringify([events, tracker.view(true), tracker.drain()])).not.toMatch(CANARY);
});

test('the parser stays cheap on a flood of token dumps (bounded CPU)', () => {
  const text = `${lines('sensitive-on').join('\n')}\n`.repeat(400);                  // ≈ 9.8 MB, 4,800 records
  const started = performance.now();
  expect(stream(text)).toHaveLength(6 * 400);
  // Only records ≤ 2 KiB are JSON-parsed; the rest is a byte scan. Typically ~40 ms; the bound only catches a regression.
  expect(performance.now() - started).toBeLessThan(2_000);
});

test('a summary counts only as its own untagged DEBUG record', () => {
  const summary = '12:00:14 Done · input 10 · cached 4 · output 20 · TTFT 1.5s · 40.0 tok/s';
  expect(parse(record(`[2026-09-29 12:00:14][DEBUG] ${summary}`, 'debug'))).toEqual(
    doneOf({ promptTokens: 10, cachedTokens: 4, outputTokens: 20, ttftMs: 1_500, decodeTps: 40 }));
  expect(parse(record(`[t][DEBUG] Done · input 1,234,567 · cached 0 · output 1 · tools 2 · TTFT 850ms`, 'debug')))
    .toEqual(doneOf({ promptTokens: 1_234_567, cachedTokens: 0, outputTokens: 1, ttftMs: 850 }));
  for (const content of [
    `[t][INFO][${MODEL}] ${summary}`, `[t][DEBUG][${MODEL}] ${summary}`, `[t][INFO] ${summary}`, `[t][DEBUG] Accumulated 9 tokens ${summary}`,
    `[t][DEBUG] text before ${summary}`, `[t][DEBUG] ${summary}\n[t][DEBUG] ${summary}`, `[t][DEBUG] Cancelled · input 1 · cached 0 · output 0`,
    '[t][DEBUG] Error · E_OOM', '[t][DEBUG] Done · input 1 · output 2', '[t][DEBUG] Done · input 1,23 · cached 0 · output 2',
    '[t][DEBUG] Done · input -1 · cached 0 · output 2', `[t][DEBUG] ${summary}${' '.repeat(1_100)}`,
  ]) expect(parse(record(content, 'debug')), content).toBeNull();
  expect(parse(record(`[t][DEBUG] ${summary}`, 'info'))).toBeNull();
  // Cached above input is not a cache figure; a zero rate or output is no rate.
  expect(parse(record('[t][DEBUG] Done · input 5 · cached 9 · output 0 · 12.5 tok/s', 'debug'))).toEqual(doneOf({ promptTokens: 5, outputTokens: 0 }));
});

test('only server.log records of one line, under the size bounds, are read at all', () => {
  const start = `[t][INFO][${MODEL}] Running chat completion on conversation with 1 messages.`;
  expect(parse(record(start))).toEqual({ kind: 'started', model: MODEL });
  for (const line of [
    JSON.stringify({ data: { type: 'model.log', content: start } }), JSON.stringify({ data: { type: 'server.log', content: 3 } }),
    JSON.stringify({ data: { type: 'server.log' } }), `x${record(start)}`, record(start).slice(0, -1), 'Streaming logs from LM Studio',
    JSON.stringify({ data: { type: 'server.log', content: start }, pad: 'p'.repeat(2_100) }), record(`${start}\r`),
    record(`[t][INFO][${MODEL}] Prompt processing progress: 250.0%`), record(`[t][INFO][] Running chat completion`), '',
  ]) expect(parse(line), line.slice(0, 60)).toBeNull();
  expect(parse(record('[t][INFO][/Users/someone/private/models/my-model.gguf] Running chat completion on conversation with 1 messages.')))
    .toEqual({ kind: 'started', model: 'my-model.gguf' });
  expect(parse(record(`[t][ERROR][${MODEL}] Generation failed`, 'error'))).toEqual({ kind: 'failed', model: MODEL });
  expect(parse(record('[t][INFO][LM STUDIO SERVER] Client disconnected. Stopping generation...'))).toBeNull();
});

const feed = (tracker: ActivityTracker, name: string) => { for (const line of lines(name)) { const event = parse(line); if (event) tracker.apply(event); } };

test('the tracker follows one request from prefill to decode to an exact, clean completion', () => {
  let now = 1_000;
  const tracker = new ActivityTracker(() => now);
  const events = lines('lifecycle').map(parse).filter(event => event !== null);
  for (const event of events.slice(0, 3)) tracker.apply(event);
  expect(tracker.view(true)).toMatchObject({ healthy: true, active: 1, request: { model: MODEL, phase: 'prefill', fraction: 0, startedAt: 1_000 },
    models: [{ model: MODEL, active: 1, phase: 'prefill', fraction: 0 }] });
  now = 1_500; tracker.apply(events[3]!);
  expect(tracker.view(true).request).toMatchObject({ phase: 'prefill', fraction: 0.375 });
  now = 2_000; tracker.apply(events[4]!);
  expect(tracker.view(true).request).toMatchObject({ phase: 'decode', fraction: null });
  now = 14_000; tracker.apply(events[5]!); tracker.apply(events[6]!);
  expect(tracker.view(true)).toMatchObject({ active: 0, request: null, models: [], seen: 1,
    averages: { decodeTps: 64.2, cacheEfficiencyFraction: 1_024 / 1_536 } });
  expect(tracker.drain()).toEqual([{ finishedAt: 14_000, startedAt: 1_000, model: MODEL, basis: 'reported', overlapped: false,
    promptTokens: 1_536, cachedTokens: 1_024, outputTokens: 812, ttftMs: 1_800, decodeTps: 64.2 }]);
  expect(tracker.drain()).toEqual([]);
  // Without a healthy stream nothing in flight is claimed; averages stay what was seen.
  expect(tracker.view(false)).toMatchObject({ healthy: false, active: 0, request: null, models: [], averages: { decodeTps: 64.2 } });
});

const done = (output: number, rate: number): ServerLineEvent => ({ kind: 'done', completion: { finishedAt: 9, startedAt: null, model: null,
  basis: 'reported', overlapped: false, promptTokens: 10, cachedTokens: 0, outputTokens: output, decodeTps: rate } });

test('overlapping requests: no per-request view, no model for an ambiguous summary, and every span marked overlapped', () => {
  let now = 0;
  const tracker = new ActivityTracker(() => now);
  tracker.apply({ kind: 'started', model: 'a' });
  now = 10; tracker.apply({ kind: 'started', model: 'b' });
  expect(tracker.view(true)).toMatchObject({ active: 2, request: null });
  tracker.apply(done(50, 80));
  tracker.apply({ kind: 'finished', model: 'b', prediction: false });
  expect(tracker.view(true)).toMatchObject({ active: 1, request: { model: 'a', startedAt: 0 } });
  tracker.apply(done(50, 70));
  expect(tracker.drain()).toEqual([
    expect.objectContaining({ model: null, startedAt: null, overlapped: true }), expect.objectContaining({ model: 'a', startedAt: 0, overlapped: true })]);
  tracker.apply({ kind: 'finished', model: 'a', prediction: false });
  // Two on one model tag: one entry, two requests, both overlapped; a later lone request is clean again.
  tracker.apply({ kind: 'started', model: 'a' }); tracker.apply({ kind: 'started', model: 'a' });
  expect(tracker.view(true)).toMatchObject({ active: 2, request: null, models: [{ model: 'a', active: 2 }] });
  tracker.apply({ kind: 'finished', model: 'a', prediction: false }); tracker.apply({ kind: 'finished', model: 'a', prediction: false });
  now = 20; tracker.apply({ kind: 'started', model: 'a' }); tracker.apply(done(5, 5));
  expect(tracker.drain()).toEqual([expect.objectContaining({ model: 'a', startedAt: 20, overlapped: false })]);
  expect(tracker.view(true).averages.decodeTps).toBeCloseTo(105 / (50 / 80 + 50 / 70 + 1), 9);
});

test('a summary with nothing in flight: the request that just ended, else an unobserved span', () => {
  let now = 0;
  const tracker = new ActivityTracker(() => now);
  tracker.apply({ kind: 'started', model: 'a' });
  now = 500; tracker.apply({ kind: 'finished', model: 'a', prediction: false });
  now = 1_500; tracker.apply(done(1, 1));
  now = 9_000; tracker.apply(done(1, 1));
  expect(tracker.drain()).toEqual([expect.objectContaining({ model: 'a', startedAt: 0, overlapped: false }),
    expect.objectContaining({ model: null, startedAt: null, overlapped: true })]);
});

test('a prediction line never ends a streamed request; stale requests and restarts are forgotten; pending is bounded', () => {
  let now = 0;
  const tracker = new ActivityTracker(() => now);
  tracker.apply({ kind: 'started', model: 'm' }); tracker.apply({ kind: 'streaming', model: 'm' }); tracker.apply({ kind: 'started', model: 'm' });
  tracker.apply({ kind: 'finished', model: 'm', prediction: true });
  expect(tracker.view(true).active).toBe(1);
  tracker.apply({ kind: 'finished', model: 'm', prediction: true });
  expect(tracker.view(true).active).toBe(1);
  tracker.apply({ kind: 'failed', model: 'm' });
  expect(tracker.view(true).active).toBe(0);
  tracker.apply({ kind: 'started', model: 'm' });
  now = 31 * 60_000;
  expect(tracker.view(true)).toMatchObject({ active: 0, request: null });
  tracker.apply({ kind: 'started', model: 'm' });
  for (let index = 0; index < 70; index += 1) tracker.apply(done(1, 1));
  tracker.resetActive();
  expect(tracker.view(true).active).toBe(0);
  expect(tracker.drain()).toHaveLength(64);
  expect(tracker.view(true).seen).toBe(70);
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: string[] = [];
  kill(signal: NodeJS.Signals) { this.killed.push(signal); this.signalCode = signal; this.emit('exit', null, signal); return true; }
  exit(code = 1) { this.exitCode = code; this.emit('exit', code, null); }
}
const HOME = '/Users/fixture', LMS = `${HOME}/.lmstudio/bin/lms`, INFO = `${HOME}/.lmstudio/.internal/http-server.json`;
const ARGS = ['log', 'stream', '-s', 'server', '--json', '--port', '41343'];
const recorder = () => {
  const spawned: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv; child: FakeChild }> = [];
  const spawn: StreamSpawn = (file, args, env) => { const child = new FakeChild(); spawned.push({ file, args, env, child }); return child; };
  return { spawned, spawn };
};
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const write = (child: FakeChild, ...contents: string[]) => {
  for (const content of contents) child.stdout.write(`${record(content, content.includes('[DEBUG]') ? 'debug' : 'info')}\n`);
};
const RUNNING = `[t][INFO][${MODEL}] Running chat completion on conversation with 1 messages.`;

test('the stream runs lms only on touch, with the exact argv and only the minimal environment', async () => {
  const { spawned, spawn } = recorder();
  let now = 100;
  const activity = createConnectionActivity({ lms: LMS, serverInfoPath: INFO, now: () => now, home: HOME, spawn, idleStopMs: 5_000 });
  expect(activity.view()).toBeNull();
  activity.touch(41_343);
  activity.touch(41_343);
  expect(spawned).toHaveLength(1);
  expect(spawned[0]).toMatchObject({ file: LMS, args: ARGS });
  expect(spawned[0]!.env).toEqual({ LANG: 'C', LC_ALL: 'C', HOME, PATH: '/usr/bin:/bin', LMS_API_SERVER_INFO_PATH: INFO });
  // Healthy only after the first server.log record, not on any output.
  spawned[0]!.child.stdout.write('Streaming logs from LM Studio\n{"timestamp":1,"data":{"type":"model.log"}}\n');
  await tick();
  expect(activity.view()).toMatchObject({ healthy: false, active: 0 });
  write(spawned[0]!.child, '[t][DEBUG] Received request: GET to /api/v1/models with body [Sensitive]', RUNNING);
  await tick();
  now = 2_100;
  expect(activity.view()).toMatchObject({ healthy: true, active: 1, request: { model: MODEL, phase: 'prefill', startedAt: 100 } });
  write(spawned[0]!.child, '[t][DEBUG] Done · input 3 · cached 0 · output 4 · 8.0 tok/s', `[t][INFO][${MODEL}] Finished streaming response`);
  await tick();
  expect(activity.view()?.completions).toEqual([{ finishedAt: 2_100, startedAt: 100, model: MODEL, basis: 'reported', overlapped: false,
    promptTokens: 3, cachedTokens: 0, outputTokens: 4, decodeTps: 8 }]);
  expect(activity.view()?.completions).toEqual([]);
  activity.dispose();
  expect(spawned[0]!.child.killed).toEqual(['SIGTERM']);
  activity.touch(41_343);
  expect(spawned).toHaveLength(1);
  expect(activity.view()).toBeNull();
});

test('no lms, a bad port, or an lms outside the allowlist never spawns', () => {
  const { spawned, spawn } = recorder();
  for (const [lms, port] of [[null, 41_343], [LMS, 0], [LMS, 70_000], ['/tmp/lms', 41_343], [`${HOME}/elsewhere/bin/lms`, 41_343]] as const) {
    const activity = createConnectionActivity({ lms, serverInfoPath: INFO, now: () => 0, home: HOME, spawn });
    activity.touch(port);
    activity.dispose();
  }
  const relative = createConnectionActivity({ lms: LMS, serverInfoPath: 'http-server.json', now: () => 0, home: HOME, spawn });
  relative.touch(41_343);
  relative.dispose();
  expect(spawned).toEqual([]);
});

test('the stream stops 60 s (here 40 ms) after the last touch', async () => {
  const { spawned, spawn } = recorder();
  const activity = createConnectionActivity({ lms: LMS, serverInfoPath: INFO, now: () => 0, home: HOME, spawn, idleStopMs: 40 });
  activity.touch(41_343);
  write(spawned[0]!.child, RUNNING);
  await tick();
  expect(activity.view()).toMatchObject({ healthy: true, active: 1 });
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(spawned[0]!.child.killed).toEqual(['SIGTERM']);
  expect(activity.view()).toMatchObject({ healthy: false, active: 0 });
  activity.touch(41_343);
  expect(spawned).toHaveLength(2);
  activity.dispose();
});

test('an ended stream restarts only inside a later touch, after the backoff; in-flight state is dropped', async () => {
  const { spawned, spawn } = recorder();
  let now = 0;
  const activity = createConnectionActivity({ lms: LMS, serverInfoPath: INFO, now: () => now, home: HOME, spawn, idleStopMs: 5_000, restartBaseMs: 1_000 });
  activity.touch(41_343);
  write(spawned[0]!.child, RUNNING);
  await tick();
  spawned[0]!.child.exit(1);
  expect(activity.view()).toMatchObject({ healthy: false, active: 0 });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(spawned).toHaveLength(1);                                   // no timer ever restarts it
  now = 999; activity.touch(41_343);
  expect(spawned).toHaveLength(1);
  now = 1_000; activity.touch(41_343);
  expect(spawned).toHaveLength(2);
  activity.dispose();
});

test('an lms that keeps exiting silently is given up until the stream idles out', async () => {
  const { spawned, spawn } = recorder();
  let now = 0;
  const activity = createConnectionActivity({ lms: LMS, serverInfoPath: INFO, now: () => now, home: HOME, spawn, idleStopMs: 40, restartBaseMs: 1 });
  for (let index = 0; index < 8; index += 1) {
    activity.touch(41_343);
    spawned.at(-1)!.child.exit(1);
    now += 60_000;
  }
  expect(spawned).toHaveLength(5);
  await new Promise(resolve => setTimeout(resolve, 80));
  activity.touch(41_343);
  expect(spawned).toHaveLength(6);
  activity.dispose();
});

test('a new internal port (the app restarted) replaces the stream; a spawn that throws backs off', () => {
  const { spawned, spawn } = recorder();
  let now = 0;
  const activity = createConnectionActivity({ lms: LMS, serverInfoPath: INFO, now: () => now, home: HOME, spawn, idleStopMs: 5_000 });
  activity.touch(41_343);
  activity.touch(50_123);
  expect(spawned.map(entry => entry.args.at(-1))).toEqual(['41343', '50123']);
  expect(spawned[0]!.child.killed).toEqual(['SIGTERM']);
  activity.dispose();
  let attempts = 0;
  const failing = createConnectionActivity({ lms: LMS, serverInfoPath: INFO, now: () => now, home: HOME, idleStopMs: 5_000,
    spawn: () => { attempts += 1; throw new Error('EACCES'); } });
  failing.touch(41_343); failing.touch(41_343);
  expect(attempts).toBe(1);
  now = 1_000; failing.touch(41_343);
  expect(attempts).toBe(2);
  failing.dispose();
});
