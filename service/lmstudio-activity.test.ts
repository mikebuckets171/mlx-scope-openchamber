import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BoundedLines, findLMStudioHome, findLms, LMStudioActivityStream, LMStudioActivityTracker, MAX_LOG_LINE_BYTES, parseLMStudioServerLine } from './lmstudio-activity.ts';

// Lines captured from LM Studio Bionic 1.1.6 with request-content redaction on.
const LINES = {
  received: '[2026-09-27 00:54:30][DEBUG] Received request: POST to /v1/chat/completions with body [Sensitive]',
  running: '[2026-09-27 00:54:30][INFO][qwen3.8-27b-splash] Running chat completion on conversation with 1 messages.',
  streaming: '[2026-09-27 00:54:30][INFO][qwen3.8-27b-splash] Streaming response...',
  progress0: '[2026-09-27 00:54:30][INFO][qwen3.8-27b-splash] Prompt processing progress: 0.0%',
  progress42: '[2026-09-27 00:54:30][INFO][qwen3.8-27b-splash] Prompt processing progress: 42.5%',
  progress100: '[2026-09-27 00:54:30][INFO][qwen3.8-27b-splash] Prompt processing progress: 100.0%',
  done: '[2026-09-27 00:54:42][DEBUG] 00:54:42 Done · input 26 · cached 0 · output 1,092 · TTFT 0.5s · 92.9 tok/s',
  finished: '[2026-09-27 00:54:42][INFO][qwen3.8-27b-splash] Finished streaming response',
  inventory: '[2026-09-27 00:54:37][INFO] Returning 5 models from v1 API',
};

test('parses the redacted LM Studio server log without reading content', () => {
  expect(parseLMStudioServerLine(LINES.received)).toBeNull();
  expect(parseLMStudioServerLine(LINES.streaming)).toEqual({ kind: 'streaming', model: 'qwen3.8-27b-splash' });
  expect(parseLMStudioServerLine(LINES.inventory)).toBeNull();
  expect(parseLMStudioServerLine(LINES.running)).toEqual({ kind: 'request', model: 'qwen3.8-27b-splash' });
  expect(parseLMStudioServerLine(LINES.progress42)).toEqual({ kind: 'prefill', model: 'qwen3.8-27b-splash', progress: 0.425 });
  expect(parseLMStudioServerLine(LINES.progress100)).toEqual({ kind: 'prefill', model: 'qwen3.8-27b-splash', progress: 1 });
  expect(parseLMStudioServerLine(LINES.done)).toEqual({ kind: 'done', promptTokens: 26, cachedTokens: 0, outputTokens: 1092,
    ttftSeconds: 0.5, tokensPerSecond: 92.9 });
  expect(parseLMStudioServerLine(LINES.finished)).toEqual({ kind: 'finished', model: 'qwen3.8-27b-splash' });
  expect(parseLMStudioServerLine('[2026-09-27 00:54:42][ERROR][qwen3.8-27b-splash] Generation failed')).toEqual({ kind: 'failed', model: 'qwen3.8-27b-splash' });
  expect(parseLMStudioServerLine('not a log line')).toBeNull();
});

// Captured from Bionic 1.1.6 for a non-streaming /v1/chat/completions request (redaction on).
const NON_STREAMING = [
  '[2026-09-27 14:00:42][INFO][local/qwen3.8-27b-splash-levels] Running chat completion on conversation with 1 messages.',
  '[2026-09-27 14:00:48][INFO][local/qwen3.8-27b-splash-levels] Prompt processing progress: 18.9%',
  '[2026-09-27 14:01:42][INFO][LM STUDIO SERVER] Client disconnected. Stopping generation... (If the model is busy processing the prompt, it will finish first.)',
  '[2026-09-27 14:01:42][INFO][local/qwen3.8-27b-splash-levels] Model generated tool calls: [Sensitive]',
  '[2026-09-27 14:01:42][INFO][local/qwen3.8-27b-splash-levels] Generated prediction: [Sensitive]',
];

test('non-streaming requests end at "Generated prediction" instead of staying in prefill', () => {
  const tracker = new LMStudioActivityTracker(() => 1_000);
  for (const line of NON_STREAMING) { const event = parseLMStudioServerLine(line); if (event) tracker.apply(event); }
  expect(tracker.view()).toMatchObject({ active: null, activeRequests: 0 });
});

test('a prediction line never ends a streamed request early', () => {
  const tracker = new LMStudioActivityTracker(() => 1_000);
  const feed = (line: string) => { const event = parseLMStudioServerLine(line); if (event) tracker.apply(event); };
  // Two overlapping requests on one model: the first streams, the second does not.
  feed(LINES.running); feed(LINES.streaming); feed(LINES.running);
  feed('[2026-09-27 00:54:31][INFO][qwen3.8-27b-splash] Generated prediction: [Sensitive]');
  expect(tracker.view().activeRequests).toBe(1);
  // A second prediction line cannot remove the still-streaming request.
  feed('[2026-09-27 00:54:32][INFO][qwen3.8-27b-splash] Generated prediction: [Sensitive]');
  expect(tracker.view().activeRequests).toBe(1);
  feed(LINES.finished);
  expect(tracker.view()).toMatchObject({ active: null, activeRequests: 0 });
});

test('keeps publisher-scoped model tags intact so they match Bionic inventory keys', () => {
  expect(parseLMStudioServerLine('[2026-09-27 09:12:00][INFO][local/qwen3.8-27b-splash-levels] Running chat completion on conversation with 2 messages.'))
    .toEqual({ kind: 'request', model: 'local/qwen3.8-27b-splash-levels' });
  expect(parseLMStudioServerLine('[2026-09-27 09:12:01][INFO][local/qwen3.8-27b-splash-levels] Prompt processing progress: 12.0%'))
    .toEqual({ kind: 'prefill', model: 'local/qwen3.8-27b-splash-levels', progress: 0.12 });
});

test('tracks a request from prompt reading to generation to exact completion figures', () => {
  let now = 1_000;
  const tracker = new LMStudioActivityTracker(() => now);
  const feed = (line: string) => { const event = parseLMStudioServerLine(line); if (event) tracker.apply(event); };
  expect(tracker.view()).toMatchObject({ active: null, activeRequests: 0, lastRequest: null, completedRequests: 0, averageDecodeTPS: null });
  feed(LINES.running); feed(LINES.progress0);
  expect(tracker.view().active).toEqual({ model: 'qwen3.8-27b-splash', phase: 'prefill', progress: 0, startedAt: 1_000, requests: 1 });
  now = 1_400; feed(LINES.progress42);
  expect(tracker.view().active).toMatchObject({ phase: 'prefill', progress: 0.425 });
  feed(LINES.progress100);
  expect(tracker.view().active).toMatchObject({ phase: 'decode', progress: null });
  now = 12_000; feed(LINES.done); feed(LINES.finished);
  const view = tracker.view();
  expect(view.active).toBeNull();
  expect(view.lastRequest).toEqual({ model: 'qwen3.8-27b-splash', tokensPerSecond: 92.9, ttftSeconds: 0.5, promptTokens: 26,
    cachedTokens: 0, outputTokens: 1092, finishedAt: 12_000 });
  expect(view.completedRequests).toBe(1);
  expect(view.averageDecodeTPS).toBeCloseTo(92.9, 5);
  expect(view.cacheEfficiencyPercent).toBe(0);
});

test('session average weights by output tokens and cache efficiency uses reported cached input', () => {
  const tracker = new LMStudioActivityTracker(() => 0);
  tracker.apply({ kind: 'done', promptTokens: 100, cachedTokens: 0, outputTokens: 100, ttftSeconds: 1, tokensPerSecond: 100 });
  tracker.apply({ kind: 'done', promptTokens: 1000, cachedTokens: 900, outputTokens: 300, ttftSeconds: 0.2, tokensPerSecond: 50 });
  const view = tracker.view();
  expect(view.averageDecodeTPS).toBeCloseTo(400 / 7, 5);
  expect(view.cacheEfficiencyPercent).toBeCloseTo(900 / 1100 * 100, 5);
});

test('overlapping requests are ambiguous: no per-request state and no model attribution for completions', () => {
  let now = 0;
  const tracker = new LMStudioActivityTracker(() => now);
  tracker.apply({ kind: 'request', model: 'a' });
  tracker.apply({ kind: 'request', model: 'b' });
  expect(tracker.view()).toMatchObject({ activeRequests: 2, concurrent: true, active: null });
  tracker.apply({ kind: 'done', promptTokens: 10, cachedTokens: 0, outputTokens: 50, ttftSeconds: 0.2, tokensPerSecond: 80 });
  expect(tracker.view().lastRequest).toMatchObject({ model: null, tokensPerSecond: 80 });
  tracker.apply({ kind: 'finished', model: 'b' });
  expect(tracker.view()).toMatchObject({ activeRequests: 1, concurrent: false, active: { model: 'a' } });
  tracker.apply({ kind: 'done', promptTokens: 10, cachedTokens: 0, outputTokens: 50, ttftSeconds: 0.2, tokensPerSecond: 70 });
  expect(tracker.view().lastRequest).toMatchObject({ model: 'a', tokensPerSecond: 70 });
});

test('requests that stop reporting are dropped after 30 minutes', () => {
  let now = 0;
  const tracker = new LMStudioActivityTracker(() => now);
  tracker.apply({ kind: 'request', model: 'm' });
  now = 31 * 60_000;
  expect(tracker.view()).toMatchObject({ active: null, activeRequests: 0, concurrent: false });
});

test('absolute and URL-like model tags are reduced to their final segment', () => {
  expect(parseLMStudioServerLine('[t][INFO][/Users/someone/private/models/my-model.gguf] Running chat completion on conversation with 1 messages.'))
    .toEqual({ kind: 'request', model: 'my-model.gguf' });
  expect(parseLMStudioServerLine('[t][INFO][~/models/qwen/] Prompt processing progress: 10%')).toEqual({ kind: 'prefill', model: 'qwen', progress: 0.1 });
  expect(parseLMStudioServerLine('[t][INFO][file:///tmp/x/secret-model] Finished streaming response')).toEqual({ kind: 'finished', model: 'secret-model' });
  expect(parseLMStudioServerLine('[t][INFO][publisher/model-name] Finished streaming response')).toEqual({ kind: 'finished', model: 'publisher/model-name' });
});

test('bounded line reader never buffers more than the limit and resumes after an oversized record', () => {
  const lines: string[] = [];
  const reader = new BoundedLines(line => lines.push(line), 32);
  reader.push(Buffer.from('short\r\npart'));
  reader.push(Buffer.from('ial\n'));
  reader.push(Buffer.from('x'.repeat(20)));
  reader.push(Buffer.from('y'.repeat(20)));
  reader.push(Buffer.from('z'.repeat(1000) + '\nafter\n'));
  expect(lines).toEqual(['short', 'partial', 'after']);
  expect(MAX_LOG_LINE_BYTES).toBe(16 * 1024);
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: string[] = [];
  kill(signal: NodeJS.Signals) { this.killed.push(signal); this.signalCode = signal; this.emit('exit', null, signal); return true; }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

/** A temporary user home with an LM Studio home whose running app recorded `infoPort` and serves REST on `restPort`. */
const fixtureHome = (options: { infoPort?: number | null; restPort?: number | null; studio?: string; pointer?: boolean } = {}) => {
  const home = mkdtempSync(path.join(tmpdir(), 'scope-lms-'));
  const studio = path.join(home, options.studio ?? '.lmstudio');
  mkdirSync(path.join(studio, '.internal'), { recursive: true });
  if (options.infoPort !== null) writeFileSync(path.join(studio, '.internal', 'http-server.json'), JSON.stringify({ host: '127.0.0.1', pid: 1, port: options.infoPort ?? 41343 }));
  if (options.restPort !== null) writeFileSync(path.join(studio, '.internal', 'http-server-config.json'), JSON.stringify({ port: options.restPort ?? 1234 }));
  if (options.pointer) writeFileSync(path.join(home, '.lmstudio-home-pointer'), `${studio}\n`);
  return { home, studio };
};
const recorder = () => {
  const spawned: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv; child: FakeChild }> = [];
  const spawnStream = (file: string, args: string[], env: NodeJS.ProcessEnv) => { const child = new FakeChild(); spawned.push({ file, args, env, child }); return child as never; };
  return { spawned, spawnStream };
};
const STREAM_ARGS = ['log', 'stream', '-s', 'server', '--json', '--port', '41343'];

test('stream runs lms only while watched, feeds the tracker, and stops when idle', async () => {
  const { spawned, spawnStream } = recorder();
  const stream = new LMStudioActivityStream({ home: fixtureHome().home, lmsPath: '/fake/lms', idleStopMs: 40, now: () => 5, spawnStream });
  expect(stream.view()).toBeNull();
  stream.touch();
  expect(spawned).toHaveLength(1);
  expect(spawned[0]).toMatchObject({ file: '/fake/lms', args: STREAM_ARGS });
  const child = spawned[0].child;
  child.stdout.write('Streaming logs from LM Studio\n');
  child.stdout.write(`${JSON.stringify({ timestamp: 1, data: { type: 'server.log', level: 'info', content: LINES.running } })}\n`);
  await tick();
  expect(stream.view()?.active).toMatchObject({ model: 'qwen3.8-27b-splash', phase: 'prefill' });
  stream.touch();
  expect(spawned).toHaveLength(1);
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(child.killed).toEqual(['SIGTERM']);
  expect(stream.view()).toBeNull();
});

test('stream is unavailable without an lms binary and never spawns', () => {
  const { spawned, spawnStream } = recorder();
  const stream = new LMStudioActivityStream({ home: fixtureHome().home, lmsPath: null, spawnStream });
  expect(stream.available).toBe(false);
  stream.touch();
  expect(spawned).toHaveLength(0);
  expect(stream.view()).toBeNull();
});

test('stream exit clears in-flight state and restarts while LM Studio still answers', async () => {
  const { spawned, spawnStream } = recorder();
  const stream = new LMStudioActivityStream({ home: fixtureHome().home, lmsPath: '/fake/lms', idleStopMs: 5_000, restartBaseMs: 20, spawnStream });
  stream.touch();
  spawned[0].child.stdout.write(`${JSON.stringify({ data: { content: LINES.running } })}\n`);
  await tick();
  expect(stream.view()?.activeRequests).toBe(1);
  spawned[0].child.exitCode = 1; spawned[0].child.emit('exit', 1, null);
  expect(stream.view()).toBeNull();
  stream.touch();
  expect(spawned).toHaveLength(1);
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(spawned).toHaveLength(2);
  stream.stop();
});

test('lms gets the explicit recorded port and the server-info path of the LM Studio home lms itself would use', () => {
  const standard = fixtureHome();
  const pointed = fixtureHome({ studio: 'custom-studio', infoPort: 50_123, pointer: true });
  mkdirSync(path.join(pointed.home, '.lmstudio', 'bin'), { recursive: true });
  const { spawned, spawnStream } = recorder();
  for (const home of [standard.home, pointed.home]) {
    const stream = new LMStudioActivityStream({ home, lmsPath: '/fake/lms', idleStopMs: 5_000, spawnStream });
    stream.touch();
    stream.stop();
  }
  expect(spawned.map(entry => entry.args)).toEqual([STREAM_ARGS, [...STREAM_ARGS.slice(0, -1), '50123']]);
  expect(spawned.map(entry => entry.env.LMS_API_SERVER_INFO_PATH)).toEqual([
    path.join(standard.studio, '.internal', 'http-server.json'), path.join(pointed.studio, '.internal', 'http-server.json')]);
  for (const entry of spawned) {
    expect(entry.env).toMatchObject({ LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' });
    expect(Object.keys(entry.env).sort()).toEqual(['HOME', 'LANG', 'LC_ALL', 'LMS_API_SERVER_INFO_PATH', 'PATH']);
  }
});

test('the LM Studio home and lms binary resolve the way lms resolves its home', () => {
  const standard = fixtureHome();
  expect(findLMStudioHome(standard.home)).toBe(standard.studio);
  const legacy = fixtureHome({ studio: path.join('.cache', 'lm-studio') });
  expect(findLMStudioHome(legacy.home)).toBe(legacy.studio);
  const pointed = fixtureHome({ studio: 'elsewhere', pointer: true });
  mkdirSync(path.join(pointed.home, '.lmstudio', 'bin'), { recursive: true });
  mkdirSync(path.join(pointed.studio, 'bin'), { recursive: true });
  writeFileSync(path.join(pointed.home, '.lmstudio', 'bin', 'lms'), '');
  writeFileSync(path.join(pointed.studio, 'bin', 'lms'), '');
  expect(findLMStudioHome(pointed.home)).toBe(pointed.studio);
  expect(findLms(pointed.home)).toBe(path.join(pointed.studio, 'bin', 'lms'));
  expect(findLms(fixtureHome().home)).toBeNull();
});

test('without a recorded server port lms is never started', async () => {
  const { spawned, spawnStream } = recorder();
  const stream = new LMStudioActivityStream({ home: fixtureHome({ infoPort: null }).home, lmsPath: '/fake/lms', idleStopMs: 5_000, restartBaseMs: 5, spawnStream });
  for (let i = 0; i < 3; i++) { stream.touch(); await tick(); }
  expect(spawned).toHaveLength(0);
  stream.stop();
});

test('only the connection on the LM Studio home REST port starts or sees the stream', async () => {
  const { spawned, spawnStream } = recorder();
  const stream = new LMStudioActivityStream({ home: fixtureHome().home, lmsPath: '/fake/lms', idleStopMs: 5_000, spawnStream });
  const tunnel = stream.forPort(1235), home = stream.forPort(1234), unknown = stream.forPort(null);
  tunnel.touch(); unknown.touch();
  expect(spawned).toHaveLength(0);
  home.touch();
  expect(spawned).toHaveLength(1);
  spawned[0].child.stdout.write(`${JSON.stringify({ data: { content: LINES.running } })}\n`);
  await tick();
  expect(home.view()?.activeRequests).toBe(1);
  expect(tunnel.view()).toBeNull();
  expect(unknown.view()).toBeNull();
  stream.stop();
  const unconfigured = new LMStudioActivityStream({ home: fixtureHome({ restPort: null }).home, lmsPath: '/fake/lms', spawnStream });
  unconfigured.forPort(1234).touch();
  expect(spawned).toHaveLength(1);
  unconfigured.stop();
});

test('a stream that ended is not restarted until LM Studio answers again', async () => {
  const { spawned, spawnStream } = recorder();
  const stream = new LMStudioActivityStream({ home: fixtureHome().home, lmsPath: '/fake/lms', idleStopMs: 5_000, restartBaseMs: 10, spawnStream });
  stream.touch();
  spawned[0].child.exitCode = 1; spawned[0].child.emit('exit', 1, null);
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(spawned).toHaveLength(1);
  stream.touch();
  expect(spawned).toHaveLength(2);
  stream.stop();
});

test('a failed spawn is retried only after LM Studio answers again', async () => {
  let attempts = 0;
  const stream = new LMStudioActivityStream({ home: fixtureHome().home, lmsPath: '/fake/lms', idleStopMs: 5_000, restartBaseMs: 10,
    spawnStream: () => { attempts += 1; throw new Error('spawn failed'); } });
  stream.touch();
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(attempts).toBe(1);
  stream.stop();
});

test('lms that keeps exiting without output is given up until Scope is reopened', async () => {
  const { spawned, spawnStream } = recorder();
  const stream = new LMStudioActivityStream({ home: fixtureHome().home, lmsPath: '/fake/lms', idleStopMs: 5_000, restartBaseMs: 2, spawnStream });
  stream.touch();
  for (let i = 0; i < 8; i++) {
    const child = spawned.at(-1)!.child;
    if (child.exitCode === null) { child.exitCode = 1; child.emit('exit', 1, null); }
    stream.touch();
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  expect(spawned).toHaveLength(5);
  stream.stop();
  stream.touch();
  expect(spawned).toHaveLength(6);
  stream.stop();
});

test('the real spawner runs lms with only the minimal environment, the explicit port and the server-info path', async () => {
  const { home, studio } = fixtureHome();
  const bin = path.join(studio, 'bin');
  mkdirSync(bin, { recursive: true });
  const stub = path.join(bin, 'lms');
  writeFileSync(stub, '#!/bin/sh\nenv > "$(/usr/bin/dirname "$0")/env.txt"\necho "$@" > "$(/usr/bin/dirname "$0")/args.txt"\necho "Streaming logs from LM Studio"\n');
  chmodSync(stub, 0o755);
  const previous = process.env.OPENCHAMBER_SERVICE_TOKEN;
  process.env.OPENCHAMBER_SERVICE_TOKEN = 'canary-service-token';
  try {
    const stream = new LMStudioActivityStream({ home, idleStopMs: 5_000 });
    expect(stream.available).toBe(true);
    stream.touch();
    for (let i = 0; i < 100 && !existsSync(path.join(bin, 'args.txt')); i++) await new Promise(resolve => setTimeout(resolve, 20));
    await new Promise(resolve => setTimeout(resolve, 50));
    stream.stop();
    expect(readFileSync(path.join(bin, 'args.txt'), 'utf8').trim()).toBe(STREAM_ARGS.join(' '));
    const env = readFileSync(path.join(bin, 'env.txt'), 'utf8');
    expect(env).toContain(`LMS_API_SERVER_INFO_PATH=${path.join(studio, '.internal', 'http-server.json')}\n`);
    expect(env).toContain('PATH=/usr/bin:/bin\n');
    expect(env).not.toContain('canary-service-token');
    expect(env).not.toContain('OPENCHAMBER');
  } finally {
    if (previous === undefined) delete process.env.OPENCHAMBER_SERVICE_TOKEN; else process.env.OPENCHAMBER_SERVICE_TOKEN = previous;
  }
});
