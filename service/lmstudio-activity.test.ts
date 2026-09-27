import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { BoundedLines, LMStudioActivityStream, LMStudioActivityTracker, MAX_LOG_LINE_BYTES, parseLMStudioServerLine } from './lmstudio-activity.ts';

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
