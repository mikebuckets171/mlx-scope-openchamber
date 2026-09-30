import { expect, test } from 'bun:test';
import { tag8 } from '../../src/contract/hash.ts';
import { SessionFeed, splitModel, WINDOW_LIMIT } from './sessions.ts';
import { CHAT, fakeHost, INSTANCE, OTHER, T0 } from './testing.ts';

const setup = (options: { mount?: boolean; instance?: string | null } = {}) => {
  const fake = fakeHost();
  let now = T0, instance: string | null = options.instance === undefined ? INSTANCE : options.instance, changes = 0;
  const create = () => {
    const feed = new SessionFeed(fake.host, () => now, () => instance);
    feed.onChange(() => { changes += 1; });
    return feed;
  };
  return { fake, create, changes: () => changes, at: (ms: number) => { now = T0 + ms; }, setInstance: (value: string | null) => { instance = value; } };
};
const busy = (session: typeof CHAT, value: boolean) => ({ ...session, busy: value });
const secretsIn = (value: unknown) => /ses_fixture|secret/i.test(JSON.stringify(value));

test('the model string splits into provider and a modelID that may itself contain slashes', () => {
  expect(splitModel('splish/publisher/Model-X')).toEqual({ provider: 'splish', model: 'publisher/Model-X' });
  expect(splitModel('omlx/Model-X')).toEqual({ provider: 'omlx', model: 'Model-X' });
  expect(splitModel('Model-X')).toEqual({ provider: null, model: 'Model-X' });
  for (const value of [undefined, '', '  ', '/Model', 'splish/']) expect(splitModel(value).provider).toBeNull();
});

test('mounting while idle: the replays (×3) set a baseline and send no mark', () => {
  const s = setup();
  s.fake.ready(CHAT);                                        // the host's ready before the frame subscribes
  const feed = s.create();                                   // subscribing replays session + lifecycle (1)
  s.at(40); s.fake.transition(CHAT); s.at(80); s.fake.transition(CHAT);   // two more replays of the same phase
  const state = feed.state();
  expect(state).toMatchObject({ connected: true, observedFrom: T0, windows: [] });
  expect(state.chat).toEqual({ tag: tag8(CHAT.id, INSTANCE), provider: 'splish', model: 'publisher/Qwen3.8-27B-4bit', busy: false });
  expect(feed.drainMarks()).toEqual([]);
});

test('mounting mid-turn: the replayed `started` opens a window whose start is unknown; only the live end is marked', () => {
  const s = setup();
  s.fake.ready(busy(CHAT, true));
  const feed = s.create();
  s.at(300); s.fake.transition(busy(CHAT, true)); s.at(310); s.fake.lifecycle(CHAT.id, 'started');
  expect(feed.state().windows).toEqual([{ tag: tag8(CHAT.id, INSTANCE), startedAt: null, endedAt: null, outcome: null,
    provider: 'splish', model: 'publisher/Qwen3.8-27B-4bit', joinedAt: T0 }]);
  expect(feed.drainMarks()).toEqual([]);
  s.at(5_000); s.fake.transition(CHAT);
  expect(feed.state().windows[0]).toMatchObject({ startedAt: null, endedAt: T0 + 5_000, outcome: 'completed' });
  expect(feed.drainMarks()).toEqual([{ phase: 'completed', at: T0 + 5_000, tag: tag8(CHAT.id, INSTANCE) }]);
});

test('a live turn is one window and one mark per edge, however many times the host repeats it', () => {
  const s = setup();
  s.fake.ready(CHAT);
  const feed = s.create();
  s.at(1_000); s.fake.transition(busy(CHAT, true));          // ready + session + lifecycle: 3 deliveries of `started`
  s.at(1_020); s.fake.transition(busy(CHAT, true));
  s.at(9_000); s.fake.transition(CHAT); s.at(9_010); s.fake.lifecycle(CHAT.id, 'completed');
  expect(feed.state().windows).toMatchObject([{ startedAt: T0 + 1_000, endedAt: T0 + 9_000, outcome: 'completed' }]);
  expect(feed.drainMarks().map(({ phase, at }) => [phase, at - T0])).toEqual([['started', 1_000], ['completed', 9_000]]);
  expect(feed.drainMarks()).toEqual([]);
});

test('a multi-step turn keeps one window across a tool pause (lifecycle stays `started`)', () => {
  const s = setup();
  s.fake.ready(CHAT); const feed = s.create();
  s.at(1_000); s.fake.transition(busy(CHAT, true));
  s.at(6_000); s.fake.lifecycle(CHAT.id, 'started'); s.fake.session(busy(CHAT, true));   // tool pause: no phase change
  s.at(12_000); s.fake.transition(CHAT);
  expect(feed.state().windows).toHaveLength(1);
  expect(feed.drainMarks()).toHaveLength(2);
});

test('an idle session followed by `failure` sharpens the same end instead of adding one', () => {
  const s = setup();
  s.fake.ready(CHAT); const feed = s.create();
  s.at(1_000); s.fake.transition(busy(CHAT, true));
  s.at(4_000); s.fake.transition(CHAT, 'failure');            // ready/session say idle first, then the real phase
  expect(feed.state().windows[0]).toMatchObject({ endedAt: T0 + 4_000, outcome: 'failure' });
  expect(feed.drainMarks().map(mark => mark.phase)).toEqual(['started', 'failure']);
  // Already sent: a late `failure` for the same end is its own mark.
  s.at(10_000); s.fake.transition(busy(CHAT, true)); s.at(12_000); s.fake.ready(CHAT);
  expect(feed.drainMarks().map(mark => mark.phase)).toEqual(['started', 'completed']);
  s.at(12_400); s.fake.lifecycle(CHAT.id, 'failure');
  expect(feed.drainMarks()).toEqual([{ phase: 'failure', at: T0 + 12_000, tag: tag8(CHAT.id, INSTANCE) }]);
  s.at(20_000); s.fake.lifecycle(CHAT.id, 'completed');       // long after: a repeat, nothing changes
  expect(feed.state().windows[1]!.outcome).toBe('failure');
});

test('a switch cuts the open window without an outcome; the new chat starts from its replay', () => {
  const s = setup();
  s.fake.ready(CHAT); const feed = s.create();
  s.at(1_000); s.fake.transition(busy(CHAT, true));
  s.at(3_000); s.fake.session(OTHER); s.fake.lifecycle(OTHER.id, 'completed'); s.fake.lifecycle(OTHER.id, 'completed');
  const state = feed.state();
  expect(state.chat?.tag).toBe(tag8(OTHER.id, INSTANCE));
  expect(state.windows).toMatchObject([{ tag: tag8(CHAT.id, INSTANCE), startedAt: T0 + 1_000, endedAt: T0 + 3_000, outcome: null }]);
  expect(state.observedFrom).toBe(T0 + 3_000);
  expect(feed.drainMarks().map(mark => mark.phase)).toEqual(['started']);
  // Back to the first chat, still running: its turn is joined again, never resumed.
  s.at(5_000); s.fake.session(busy(CHAT, true));
  expect(feed.state().windows.at(-1)).toMatchObject({ tag: tag8(CHAT.id, INSTANCE), startedAt: null, joinedAt: T0 + 5_000 });
  expect(feed.drainMarks()).toEqual([]);
});

test('a lifecycle event for a chat the frame has not seen yet is a switch; onSession fills in its model', () => {
  const s = setup();
  s.fake.ready(CHAT); const feed = s.create();
  s.at(1_000); s.fake.lifecycle(OTHER.id, 'started');
  expect(feed.state().chat).toMatchObject({ tag: tag8(OTHER.id, INSTANCE), provider: null, model: null });
  expect(feed.state().windows.at(-1)).toMatchObject({ startedAt: null, provider: null, model: null });
  s.fake.session(busy(OTHER, true));
  expect(feed.state().windows.at(-1)).toMatchObject({ provider: 'splish', model: 'publisher/Qwen3.8-27B-4bit' });
});

test('no open chat, a model change mid-turn, and identical payloads', () => {
  const s = setup();
  s.fake.ready(CHAT); const feed = s.create();
  const before = s.changes();
  s.fake.session(CHAT); s.fake.session({ ...CHAT, title: 'Renamed secret' });   // same id, busy and model: deduped
  expect(s.changes()).toBe(before);
  s.at(1_000); s.fake.transition(busy(CHAT, true));
  s.fake.session({ ...busy(CHAT, true), model: 'splish/publisher/Other-Model' });
  expect(feed.state().windows[0]!.model).toBeNull();
  s.at(2_000); s.fake.session(null);
  expect(feed.state()).toMatchObject({ connected: false, chat: null, observedFrom: null });
  expect(feed.state().windows[0]).toMatchObject({ endedAt: T0 + 2_000, outcome: null });
});

test('hiding unsubscribes and ends observation; showing again replays a baseline', () => {
  const s = setup();
  s.fake.ready(busy(CHAT, true)); const feed = s.create();
  expect(s.fake.listeners()).toBe(1);
  s.at(2_000); feed.setActive(false);
  expect(feed.active).toBe(false);
  expect(feed.state()).toMatchObject({ connected: false, observedFrom: null });
  expect(feed.state().windows[0]).toMatchObject({ endedAt: T0 + 2_000, outcome: null });
  s.at(3_000); s.fake.transition(CHAT); s.fake.transition(busy(CHAT, true));   // missed while hidden
  expect(feed.state().windows).toHaveLength(1);
  s.at(4_000); feed.setActive(true);
  expect(feed.state().windows.at(-1)).toMatchObject({ startedAt: null, joinedAt: T0 + 4_000 });
  expect(feed.drainMarks()).toEqual([]);
  feed.dispose();
  expect(feed.state()).toMatchObject({ chat: null, windows: [] });
});

test('marks wait for the service instance; tags are salted with it and nothing names the chat', () => {
  const s = setup({ instance: null });
  s.fake.ready(CHAT); const feed = s.create();
  s.at(1_000); s.fake.transition(busy(CHAT, true));
  expect(feed.drainMarks()).toEqual([]);
  const local = feed.state().chat!.tag;
  s.setInstance(INSTANCE);
  expect(feed.state().chat!.tag).not.toBe(local);
  const marks = feed.drainMarks();
  expect(marks).toEqual([{ phase: 'started', at: T0 + 1_000, tag: tag8(CHAT.id, INSTANCE) }]);
  s.setInstance('0a1b2c3d');
  expect(feed.state().chat!.tag).toBe(tag8(CHAT.id, '0a1b2c3d'));
  expect(secretsIn(feed.state())).toBe(false);
  expect(secretsIn(marks)).toBe(false);
});

test('windows and marks are bounded', () => {
  const s = setup({ instance: null });
  s.fake.ready(CHAT); const feed = s.create();
  for (let turn = 0; turn < 40; turn += 1) {
    s.at(turn * 10_000 + 1_000); s.fake.transition(busy(CHAT, true));
    s.at(turn * 10_000 + 5_000); s.fake.transition(CHAT);
  }
  expect(feed.state().windows).toHaveLength(WINDOW_LIMIT);
  expect(feed.state().windows.at(-1)!.startedAt).toBe(T0 + 391_000);
  s.setInstance(INSTANCE);
  expect(feed.drainMarks()).toHaveLength(16);
});
