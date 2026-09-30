import { expect, test } from 'bun:test';
import type { CompletionV2 } from '../../src/contract/completion.ts';
import { ActivityTrack } from './coverage.ts';
import type { JoinContext } from './join.ts';
import { NextReply, REPLY_LIMIT_MS, REPLY_WAIT_MS, type NextReplyState } from './next-reply.ts';
import { SessionFeed } from './sessions.ts';
import { body, CHAT, fakeHost, INSTANCE, OTHER, step, T0 } from './testing.ts';

// PR #8's reply-capture tests, ported to completions and lifecycle windows, plus the 2.0 per-step checks.
const RUNTIME = 'mlx-community/Qwen3.8-27B-4bit';
const fixture = (options: { busy?: boolean; context?: Partial<JoinContext> } = {}) => {
  const fake = fakeHost(), activity = new ActivityTrack(), reply = new NextReply();
  let now = T0, extra: Partial<JoinContext> = options.context ?? {};
  fake.ready({ ...CHAT, busy: options.busy ?? false });
  const feed = new SessionFeed(fake.host, () => now, () => INSTANCE);
  const context = (): JoinContext => ({ connection: { id: 'splish', runtime: 'lmstudio', model: RUNTIME, models: [RUNTIME], choices: ['splish', 'omlx'] },
    canCount: true, auto: true, covered: (from, to) => activity.covered(from, to), activeMax: (from, to) => activity.activeMax(from, to),
    idleBefore: at => activity.idleBefore(at), ...extra });
  /** One poll at `ms`: a reading with `active` requests and any completions it delivers. */
  const poll = (ms: number, active = 0, items: CompletionV2[] = []): NextReplyState => {
    now = T0 + ms;
    activity.observe(body({ at: now, active, items }), now);
    return reply.observe(items, feed.state(), now, { context: context(), sampledAt: now });
  };
  /** Polls every 500 ms through [from, to) with `active` requests. */
  const run = (from: number, to: number, active = 0) => { for (let ms = from; ms < to; ms += 500) poll(ms, active); };
  const chat = (ms: number, busy: boolean, session = CHAT) => { now = T0 + ms; fake.transition({ ...session, busy }); };
  const arm = (ms: number) => { now = T0 + ms; return reply.arm(now, feed.state(), context()); };
  return { fake, feed, reply, poll, run, chat, arm, context, setContext: (value: Partial<JoinContext>) => { extra = value; } };
};
const reply1 = (seq: number, startedAt: number, finishedAt: number, value: Partial<CompletionV2> = {}) =>
  step({ seq, startedAt: T0 + startedAt, finishedAt: T0 + finishedAt, model: RUNTIME, ...value });

/** Armed at 0; the reply runs 1.0–11.4 s with two steps and a tool pause; readings every 500 ms. */
const twoStepReply = (f: ReturnType<typeof fixture>, second: Partial<CompletionV2> = {}, secondActive = 1) => {
  f.run(0, 1_000); f.arm(900); f.chat(1_000, true);
  f.run(1_000, 5_000, 1); f.poll(5_000, 0, [reply1(11, 1_200, 4_900, { outputTokens: 600, decodeTps: 30 })]);
  f.run(5_500, 7_000, 0);                                      // tool pause: lifecycle stays `started`
  f.run(7_000, 11_000, secondActive); f.poll(11_000, 0, [reply1(12, 7_100, 10_900, { outputTokens: 400, decodeTps: 40, ...second })]);
  f.chat(11_400, false);
};

test('next reply needs an explicit arm and measures only the next turn', () => {
  const f = fixture();
  f.run(0, 1_000); expect(f.reply.state).toEqual({ kind: 'idle' });
  f.chat(1_000, true); f.run(1_000, 3_000, 1); f.chat(3_000, false); f.run(3_000, 5_000);
  expect(f.reply.state).toEqual({ kind: 'idle' });
  expect(f.arm(5_000)).toEqual({ kind: 'armed', at: T0 + 5_000 });
  expect(f.arm(5_100)).toEqual({ kind: 'armed', at: T0 + 5_000 });
  f.run(5_000, 9_000);
  expect(f.reply.state.kind).toBe('armed');
});

test('replayed lifecycle and session events cannot start or restart a capture', () => {
  const f = fixture();
  f.run(0, 1_000); f.arm(900);
  for (let index = 0; index < 3; index += 1) { f.chat(1_000 + index, false); f.fake.lifecycle(CHAT.id, 'completed'); }
  f.feed.setActive(false); f.fake.ready({ ...CHAT, busy: true }); f.feed.setActive(true);   // a remount mid-turn replays `started`
  f.run(1_000, 3_000, 1);
  expect(f.reply.state.kind).toBe('armed');
  f.chat(3_000, false); f.run(3_000, 4_000);
  f.chat(4_000, true); f.poll(4_500, 1);
  expect(f.reply.state).toEqual({ kind: 'measuring', startedAt: T0 + 4_000, steps: [] });
});

test('a turn already running when armed is not the next reply', () => {
  const f = fixture({ busy: true });
  f.run(0, 2_000, 1); f.arm(2_000);
  f.run(2_000, 4_000, 1); f.poll(4_000, 0, [reply1(3, 0, 3_900)]); f.chat(4_200, false); f.run(4_500, 6_000);
  expect(f.reply.state.kind).toBe('armed');
  f.chat(6_000, true); f.run(6_000, 8_000, 1); f.poll(8_000, 0, [reply1(4, 6_200, 7_900)]); f.chat(8_300, false); f.run(8_500, 10_000);
  expect(f.reply.state).toMatchObject({ kind: 'result', startedAt: T0 + 6_000, attributed: true });
  expect((f.reply.state as { steps: CompletionV2[] }).steps.map(item => item.seq)).toEqual([4]);
});

test('every step of one reply is checked on its own; the result waits for a reading after the end', () => {
  const f = fixture();
  twoStepReply(f);
  f.poll(11_500, 0, [reply1(13, 11_900, 14_000)]);               // a post-turn request: not a step
  expect(f.reply.state.kind).toBe('measuring');
  f.poll(12_300);
  expect(f.reply.state.kind).toBe('measuring');                // 0.9 s after the end
  f.poll(12_500);
  const state = f.reply.state as Extract<NextReplyState, { kind: 'result' }>;
  expect(state).toMatchObject({ kind: 'result', startedAt: T0 + 1_000, endedAt: T0 + 11_400, attributed: true });
  expect(state.steps.map(item => [item.seq, item.verdict?.attr])).toEqual([[11, 'armed'], [12, 'armed']]);
  expect(state.summary).toMatchObject({ steps: 2, wallMs: 10_400, modelMs: 3_700 + 3_800, toolMs: 10_400 - 7_500, outputTokens: 1_000 });
  expect(f.reply.drainAttrs()).toEqual([{ seq: 11, attr: 'armed', reason: null }, { seq: 12, attr: 'armed', reason: null }]);
  expect(f.reply.drainAttrs()).toEqual([]);
});

test('a failing step stays server-wide with its reason, and then the reply is not attributed', () => {
  const cases: Array<[Partial<CompletionV2>, number, string, boolean]> = [
    [{ model: 'mlx-community/Other-Model-8bit' }, 1, 'model-differs', false],
    [{ overlapped: true }, 1, 'overlap', true],
    [{ aggregateOf: 2 }, 1, 'overlap', true],
    [{}, 2, 'overlap', true],                                  // this frame saw a second request during the step
    [{ startedAt: null }, 1, 'inferred-start', false],         // no reported start: placed after the last idle reading
  ];
  for (const [second, active, reason, overlapped] of cases) {
    const f = fixture();
    twoStepReply(f, second, active); f.run(11_500, 13_000);
    const state = f.reply.state as Extract<NextReplyState, { kind: 'result' }>;
    const failing = state.steps[1]!;
    if (reason === 'inferred-start') { expect(state.attributed).toBe(true); continue; }
    expect(state).toMatchObject({ kind: 'result', attributed: false, summary: null });
    expect(failing.verdict).toMatchObject({ attr: 'withheld', reason });
    expect(failing.overlapped).toBe(overlapped);
    expect(f.reply.drainAttrs().map(item => item.seq)).toEqual([11]);
  }
});

test('it will not arm on another provider or model; a watchable provider is offered instead', () => {
  const f = fixture();
  f.run(0, 1_000);
  f.fake.session({ ...CHAT, model: 'omlx/Qwen3.8-27B-4bit' });
  expect(f.arm(1_000)).toEqual({ kind: 'offer-watch', runtime: 'omlx' });
  f.fake.session({ ...CHAT, model: 'cloud/big-model' });
  expect(f.arm(1_100)).toEqual({ kind: 'refused', reason: 'other-provider' });
  f.fake.session({ ...CHAT, model: 'splish/publisher/Other-Model' });
  expect(f.arm(1_200)).toEqual({ kind: 'refused', reason: 'model-differs' });
  f.fake.session({ ...CHAT, model: undefined });
  expect(f.arm(1_300)).toEqual({ kind: 'refused', reason: 'model-unknown' });
  f.fake.session(CHAT);
  f.setContext({ canCount: false });
  expect(f.arm(1_400)).toEqual({ kind: 'refused', reason: 'cannot-count' });
  f.setContext({ connection: { id: 'splish', runtime: 'lmstudio', model: null, models: [] } });
  expect(f.arm(1_500).kind).toBe('armed');                     // a runtime that names no model: each step decides
  f.reply.cancel('user');
  f.setContext({ connection: { id: 'splish', runtime: 'lmstudio', model: null, models: ['a/Other', RUNTIME] } });
  expect(f.arm(1_600).kind).toBe('armed');                     // one of several loaded models matches
  f.reply.cancel('user');
  f.fake.session(null);
  expect(f.arm(1_700)).toEqual({ kind: 'refused', reason: 'not-observed' });
  f.reply.cancel('user');
  expect(f.reply.state).toEqual({ kind: 'idle' });
});

test('switch, missing session, hide and runtime loss stop safely; verified steps keep their label', () => {
  for (const reason of ['switch', 'missing', 'hidden', 'unavailable', 'user'] as const) {
    const f = fixture();
    f.run(0, 1_000); f.arm(900); f.chat(1_000, true);
    f.run(1_000, 5_000, 1); f.poll(5_000, 0, [reply1(11, 1_200, 4_900)]);
    if (reason === 'switch') f.fake.session({ ...OTHER, busy: true });
    if (reason === 'missing') f.fake.session(null);
    if (reason === 'hidden' || reason === 'unavailable' || reason === 'user') f.reply.cancel(reason);
    f.poll(5_500, 1, [reply1(12, 5_100, 5_400)]);
    expect(f.reply.state).toEqual({ kind: 'cancelled', reason: reason === 'switch' || reason === 'missing' ? 'switched' : reason });
    expect(f.reply.active).toBe(false);
    expect(f.reply.drainAttrs().map(item => item.seq)).toEqual([11]);
  }
});

test('a switch while armed cancels rather than following another chat', () => {
  const f = fixture();
  f.run(0, 1_000); f.arm(900);
  f.chat(1_000, true, OTHER); f.poll(1_500, 1);
  expect(f.reply.state).toEqual({ kind: 'cancelled', reason: 'switched' });
});

test('the wait and recording limits use the existing polls, without timers', () => {
  let f = fixture();
  f.run(0, 1_000); f.arm(900);
  f.poll(900 + REPLY_WAIT_MS - 1);
  expect(f.reply.state.kind).toBe('armed');
  f.poll(900 + REPLY_WAIT_MS);
  expect(f.reply.state).toEqual({ kind: 'cancelled', reason: 'timeout' });
  f = fixture();
  f.run(0, 1_000); f.arm(900); f.chat(1_000, true); f.poll(1_500, 1);
  f.poll(1_000 + REPLY_LIMIT_MS, 1);
  expect(f.reply.state).toEqual({ kind: 'cancelled', reason: 'limit' });
});

test('a clock running backwards cancels, beyond the tolerance', () => {
  const f = fixture();
  f.run(0, 10_000); f.arm(10_000);
  f.poll(9_500);
  expect(f.reply.state.kind).toBe('armed');
  f.poll(8_000);
  expect(f.reply.state).toEqual({ kind: 'cancelled', reason: 'clock' });
});

test('a turn with no runtime activity is a result with no steps, never a zero-speed one', () => {
  const f = fixture();
  f.run(0, 1_000); f.arm(900); f.chat(1_000, true); f.run(1_000, 3_000); f.chat(3_000, false); f.run(3_000, 5_000);
  expect(f.reply.state).toEqual({ kind: 'result', startedAt: T0 + 1_000, endedAt: T0 + 3_000, steps: [], attributed: false, summary: null });
  expect(f.arm(5_000).kind).toBe('armed');                     // arming again clears the result
});
