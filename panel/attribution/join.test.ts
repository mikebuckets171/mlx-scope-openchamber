import { expect, test } from 'bun:test';
import type { WithholdReason } from '../../src/contract/reasons.ts';
import { CLOCK_TOLERANCE_MS, join, joinLive, labelOf, sameModel, type JoinContext, type Span } from './join.ts';
import type { FrameSessionState, TurnWindow } from './sessions.ts';
import { T0 } from './testing.ts';

const CHAT_MODEL = 'publisher/Qwen3.8-27B-4bit', RUNTIME_MODEL = 'mlx-community/Qwen3.8-27B-4bit';
const window = (value: Partial<TurnWindow> = {}): TurnWindow =>
  ({ tag: 'aaaaaaaa', startedAt: T0 + 1_000, endedAt: T0 + 20_000, outcome: 'completed', provider: 'splish', model: CHAT_MODEL, ...value });
const frame = (value: Partial<FrameSessionState> = {}): FrameSessionState => ({ connected: true, observedFrom: T0 - 60_000,
  chat: { tag: 'aaaaaaaa', provider: 'splish', model: CHAT_MODEL, busy: false }, windows: [window()], ...value });
const context = (value: Partial<JoinContext> = {}): JoinContext => ({ connection: { id: 'splish', runtime: 'lmstudio', model: null },
  canCount: true, covered: () => true, auto: true, activeMax: () => 1, idleBefore: () => null, ...value });
const span = (value: Partial<Span> = {}): Span => ({ startedAt: T0 + 1_200, finishedAt: T0 + 8_000, model: RUNTIME_MODEL, overlapped: false, ...value });
const reason = (s: Span, f: FrameSessionState, c: JoinContext): WithholdReason | 'inferred' => {
  const verdict = join(s, f, c);
  return verdict.attr === 'inferred' ? 'inferred' : verdict.reason;
};

// Each condition of the S2 rule, in precedence order, as a change that makes only it fail.
type Case = { s: Span; f: FrameSessionState; c: JoinContext };
const CONDITIONS: Array<[WithholdReason, (value: Case) => void]> = [
  ['auto-off', v => { v.c.auto = false; }],
  ['other-provider', v => { v.f = { ...v.f, chat: { ...v.f.chat!, provider: 'cloud' }, windows: v.f.windows.map(w => ({ ...w, provider: 'cloud' })) }; }],
  ['model-differs', v => { v.s.model = 'mlx-community/Other-Model-8bit'; }],
  ['cannot-count', v => { v.c.canCount = false; }],
  ['overlap', v => { v.s.overlapped = true; }],
  ['joined-mid-turn', v => { v.f = { ...v.f, windows: v.f.windows.map(w => ({ ...w, startedAt: null, joinedAt: T0 })) }; }],
  ['overlap', v => { v.c.activeMax = () => 2; }],
  ['outside-turn', v => { v.s.startedAt = T0 + 1_000 - CLOCK_TOLERANCE_MS - 2_000; }],
  ['not-observed', v => { v.c.covered = () => false; }],
];

test('exhaustive truth table: inferred only when every condition holds, else the first failing reason', () => {
  expect(reason(span(), frame(), context())).toBe('inferred');
  for (let mask = 0; mask < 1 << CONDITIONS.length; mask += 1) {
    const value: Case = { s: span(), f: frame(), c: context() };
    CONDITIONS.forEach(([, fail], bit) => { if (mask & 1 << bit) fail(value); });
    const first = CONDITIONS.find((_, bit) => mask & 1 << bit);
    expect(reason(value.s, value.f, value.c), `mask ${mask.toString(2)}`).toBe(first ? first[0] : 'inferred');
  }
});

test('provider and model: the monitored connection, the last path segment, case-folded', () => {
  expect(sameModel('publisher/Qwen3.8-27B-4bit', 'mlx-community/qwen3.8-27b-4BIT')).toBe(true);
  expect(sameModel('Qwen3.8-27B-4bit', ' qwen3.8-27b-4bit ')).toBe(true);
  expect(sameModel('publisher/Qwen3.8-27B-4bit', 'publisher/Qwen3.8-27B-8bit')).toBe(false);
  expect(sameModel('publisher/', 'other/')).toBe(false);
  expect(sameModel(null, RUNTIME_MODEL)).toBe(false);
  const unknownChat = frame({ chat: { tag: 'aaaaaaaa', provider: null, model: null, busy: false }, windows: [window({ provider: null, model: null })] });
  expect(reason(span(), unknownChat, context())).toBe('model-unknown');
  expect(reason(span({ model: null }), frame(), context())).toBe('model-unknown');
  // The completion's own model is preferred; the runtime's single model is the fallback.
  expect(reason(span({ model: null }), frame(), context({ connection: { id: 'splish', runtime: 'lmstudio', model: RUNTIME_MODEL } }))).toBe('inferred');
  expect(reason(span({ model: 'x/Other' }), frame(), context({ connection: { id: 'splish', runtime: 'lmstudio', model: RUNTIME_MODEL } }))).toBe('model-differs');
  // The window keeps the chat's identity at the time: a later switch to a cloud chat does not relabel it.
  expect(reason(span(), frame({ chat: { tag: 'bbbbbbbb', provider: 'cloud', model: 'm', busy: false } }), context())).toBe('inferred');
  expect(reason(span(), frame({ windows: [window({ model: null })] }), context())).toBe('model-unknown');
  expect(reason(span({ aggregateOf: 2 }), frame(), context())).toBe('overlap');
});

test('the span must lie inside a live-observed turn, ±1 s', () => {
  const at = (startedAt: number, finishedAt: number, f = frame()) => reason(span({ startedAt: T0 + startedAt, finishedAt: T0 + finishedAt }), f, context());
  expect(at(0, 5_000)).toBe('inferred');                       // started 1 s before `started` arrived: inside tolerance
  expect(at(-1, 5_000)).toBe('outside-turn');
  expect(at(15_000, 21_000)).toBe('inferred');
  expect(at(15_000, 21_001)).toBe('outside-turn');             // post-turn background (title/recap) request
  expect(at(22_000, 25_000)).toBe('outside-turn');
  expect(at(5_000, 30_000, frame({ windows: [window({ endedAt: null, outcome: null })] }))).toBe('inferred');   // still running
  // A window cut by a switch or hide: past its end the frame was not looking.
  expect(at(5_000, 30_000, frame({ windows: [window({ outcome: null })] }))).toBe('not-observed');
  // Outside every window: outside-turn only if the frame was watching the chat since before the span.
  expect(at(30_000, 35_000, frame({ windows: [] }))).toBe('outside-turn');
  expect(at(30_000, 35_000, frame({ windows: [], observedFrom: T0 + 31_000 }))).toBe('not-observed');
  expect(at(30_000, 35_000, frame({ windows: [], connected: false }))).toBe('not-observed');
  expect(at(30_000, 35_000, frame({ windows: [], chat: null }))).toBe('not-observed');
  expect(at(0, 25_000, frame({ observedFrom: T0 + 500 }))).toBe('not-observed');   // partly outside, start unseen
});

test('joined mid-turn only for spans still running when the frame joined', () => {
  const joined = frame({ windows: [window({ startedAt: null, joinedAt: T0 + 10_000 })], observedFrom: T0 + 10_000 });
  expect(reason(span({ startedAt: T0 + 2_000, finishedAt: T0 + 12_000 }), joined, context())).toBe('joined-mid-turn');
  expect(reason(span({ startedAt: T0 + 12_000, finishedAt: T0 + 15_000 }), joined, context())).toBe('joined-mid-turn');
  expect(reason(span({ startedAt: T0 + 2_000, finishedAt: T0 + 9_000 }), joined, context())).toBe('not-observed');
});

test('a completion without a reported start is placed after the last idle reading, or not at all', () => {
  const s = span({ startedAt: null });
  expect(reason(s, frame(), context())).toBe('not-observed');
  expect(reason(s, frame(), context({ idleBefore: () => T0 + 1_100 }))).toBe('inferred');
  expect(reason(s, frame(), context({ idleBefore: () => T0 - 5_000 }))).toBe('outside-turn');
  expect(reason(s, frame(), context({ idleBefore: undefined }))).toBe('not-observed');
});

test('this frame’s readings: counts across the lag before the span too, and one unbroken stretch', () => {
  const asked: Array<[number, number]> = [];
  const probe = context({ activeMax: (from, to) => { asked.push([from, to]); return 1; }, covered: (from, to) => { asked.push([from, to]); return true; } });
  expect(reason(span(), frame(), probe)).toBe('inferred');
  expect(asked).toEqual([[T0 + 200, T0 + 8_000], [T0 + 200, T0 + 8_000]]);
  expect(reason(span(), frame(), context({ activeMax: () => null }))).toBe('cannot-count');
  expect(reason(span(), frame(), context({ activeMax: undefined }))).toBe('inferred');   // the service's `overlapped` alone
});

test('clock skew ±5 s against the tolerance: only service-time stamps keep a post-turn request out', () => {
  // Stamps are taken on the service clock (SnapshotClient.now); a frame clock off by 5 s, uncorrected, would move the
  // window by 5 s — far beyond the 1 s tolerance. These spans show what that would do, which is why the offset matters.
  const post = span({ startedAt: T0 + 20_500, finishedAt: T0 + 23_000 });
  expect(reason(post, frame(), context())).toBe('outside-turn');
  const late = frame({ windows: [window({ startedAt: T0 + 6_000, endedAt: T0 + 25_000 })] });
  expect(reason(post, late, context())).toBe('inferred');       // +5 s uncorrected: a false label
  const early = frame({ windows: [window({ startedAt: T0 - 4_000, endedAt: T0 + 15_000 })] });
  expect(reason(span(), early, context())).toBe('inferred');
  expect(reason(span({ finishedAt: T0 + 18_000 }), early, context())).toBe('outside-turn');   // −5 s: a real step lost
});

test('the live reading: the open turn so far', () => {
  const open = frame({ windows: [window({ endedAt: null, outcome: null })] });
  expect(joinLive(open, context(), T0 + 9_000, RUNTIME_MODEL)).toEqual({ attr: 'inferred' });
  expect(joinLive(frame({ windows: [window({ startedAt: null, endedAt: null, outcome: null, joinedAt: T0 })] }), context(), T0 + 9_000, RUNTIME_MODEL))
    .toEqual({ attr: 'withheld', reason: 'joined-mid-turn' });
  expect(joinLive(frame(), context({ idleBefore: () => T0 + 30_000 }), T0 + 31_000, RUNTIME_MODEL)).toEqual({ attr: 'withheld', reason: 'outside-turn' });
  expect(joinLive(open, context({ activeMax: () => 2 }), T0 + 9_000, RUNTIME_MODEL)).toEqual({ attr: 'withheld', reason: 'overlap' });
});

test('labels: a server-wide label always carries a reason', () => {
  expect(labelOf({})).toEqual({ kind: 'server-wide', reason: 'not-observed' });
  expect(labelOf({ verdict: { attr: 'inferred', at: T0 } })).toEqual({ kind: 'inferred' });
  expect(labelOf({ verdict: { attr: 'armed', at: T0 } })).toEqual({ kind: 'armed' });
  expect(labelOf({ verdict: { attr: 'withheld', reason: 'overlap', at: T0 } })).toEqual({ kind: 'server-wide', reason: 'overlap' });
});
