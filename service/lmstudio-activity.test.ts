import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LMStudioActivityStream, LMStudioActivityTracker, parseLMStudioServerLine } from './lmstudio-activity.ts';

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
  expect(parseLMStudioServerLine(LINES.streaming)).toBeNull();
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

test('overlapping requests on one model stay active until each finishes, and abandoned requests expire', () => {
  let now = 0;
  const tracker = new LMStudioActivityTracker(() => now);
  tracker.apply({ kind: 'request', model: 'm' });
  tracker.apply({ kind: 'request', model: 'm' });
  expect(tracker.view()).toMatchObject({ activeRequests: 2, active: { requests: 2 } });
  tracker.apply({ kind: 'finished', model: 'm' });
  expect(tracker.view()).toMatchObject({ activeRequests: 1 });
  now = 31 * 60_000;
  expect(tracker.view()).toMatchObject({ active: null, activeRequests: 0 });
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

test('stream runs lms only while watched, feeds the tracker, and stops when idle', async () => {
  const spawned: Array<{ file: string; args: string[]; child: FakeChild }> = [];
  const stream = new LMStudioActivityStream({ lmsPath: '/fake/lms', idleStopMs: 40, now: () => 5,
    spawnStream: (file, args) => { const child = new FakeChild(); spawned.push({ file, args, child }); return child as never; } });
  expect(stream.view()).toBeNull();
  stream.touch();
  expect(spawned).toHaveLength(1);
  expect(spawned[0]).toMatchObject({ file: '/fake/lms', args: ['log', 'stream', '-s', 'server', '--json'] });
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
  let spawned = 0;
  const stream = new LMStudioActivityStream({ lmsPath: null, spawnStream: () => { spawned += 1; return new FakeChild() as never; } });
  expect(stream.available).toBe(false);
  stream.touch();
  expect(spawned).toBe(0);
  expect(stream.view()).toBeNull();
});

test('stream exit clears in-flight state and restarts while still watched', async () => {
  const children: FakeChild[] = [];
  const stream = new LMStudioActivityStream({ lmsPath: '/fake/lms', idleStopMs: 5_000,
    spawnStream: () => { const child = new FakeChild(); children.push(child); return child as never; } });
  stream.touch();
  children[0].stdout.write(`${JSON.stringify({ data: { content: LINES.running } })}\n`);
  await tick();
  expect(stream.view()?.activeRequests).toBe(1);
  children[0].exitCode = 1; children[0].emit('exit', 1, null);
  expect(stream.view()).toBeNull();
  await new Promise(resolve => setTimeout(resolve, 1_100));
  expect(children).toHaveLength(2);
  stream.stop();
});
