import { expect, spyOn, test } from 'bun:test';
import { HostEvents, sessionOf } from './openchamber.ts';
import { CHAT, fakeHost } from '../attribution/testing.ts';
import { SessionFeed } from '../attribution/sessions.ts';

const setup = () => {
  const fake = fakeHost(), calls = { session: 0, lifecycle: 0 }, live = { session: 0, lifecycle: 0 };
  const host = { ...fake.host,
    onSession: ((listener) => {
      calls.session++; live.session++;
      const stop = fake.host.onSession(listener);
      return () => { live.session--; stop(); };
    }) as typeof fake.host.onSession,
    onSessionLifecycle: ((listener) => {
      calls.lifecycle++; live.lifecycle++;
      const stop = fake.host.onSessionLifecycle(listener);
      return () => { live.lifecycle--; stop(); };
    }) as typeof fake.host.onSessionLifecycle,
  };
  return { fake, calls, live, events: new HostEvents(host) };
};

test('one visible SDK feed serves every consumer and discards host titles', () => {
  const s = setup(), first: unknown[] = [], second: unknown[] = [], phases: unknown[] = [];
  s.events.onSession(value => first.push(value)); s.events.onSession(value => second.push(value));
  s.events.onSessionLifecycle(value => phases.push(value));
  s.fake.ready(CHAT);
  expect(first).toEqual([]); expect(s.live).toEqual({ session: 0, lifecycle: 0 });
  s.events.setVisible(true); s.events.setVisible(true);
  s.fake.transition(CHAT); s.fake.session({ ...CHAT, title: 'Another private title' });
  expect(s.calls).toEqual({ session: 1, lifecycle: 1 });
  expect(first).toEqual([{ id: CHAT.id, busy: false, model: CHAT.model }]);
  expect(second).toEqual(first); expect(phases).toEqual([{ sessionId: CHAT.id, phase: 'completed' }]);
  expect(JSON.stringify(first)).not.toContain('title');
  s.events.dispose(); expect(s.live).toEqual({ session: 0, lifecycle: 0 });
});

test('hidden ready and lifecycle injections do no view work; showing replays the current baseline', () => {
  const s = setup(), ready: unknown[] = [], sessions: unknown[] = [], phases: unknown[] = [];
  s.events.onReady(value => ready.push(value));
  s.events.onSession(value => sessions.push(value));
  s.events.onSessionLifecycle(value => phases.push(value));
  s.fake.ready(CHAT); s.fake.transition({ ...CHAT, busy: true });
  expect(ready).toHaveLength(1); expect(sessions).toHaveLength(0); expect(phases).toHaveLength(0);
  s.events.setVisible(true);
  expect(sessions).toEqual([{ id: CHAT.id, busy: true, model: CHAT.model }]);
  s.events.setVisible(false);
  expect(s.live).toEqual({ session: 0, lifecycle: 0 });
  s.fake.transition(CHAT); s.fake.transition({ ...CHAT, busy: true });
  expect(ready).toHaveLength(1); expect(sessions).toHaveLength(1); expect(phases).toHaveLength(1);
  s.events.setVisible(true);
  expect(sessions).toHaveLength(2); expect(phases).toHaveLength(2);
  s.events.dispose(); s.events.dispose();
  s.fake.transition(CHAT); s.events.setVisible(true);
  expect(sessions).toHaveLength(2); expect(s.live).toEqual({ session: 0, lifecycle: 0 });
});

test('a resumed attribution feed never bridges lifecycle work missed while hidden', () => {
  const s = setup(); let now = 1_000;
  s.fake.ready(CHAT); s.events.setVisible(true);
  const feed = new SessionFeed(s.events, () => now, () => '1234abcd');
  now = 2_000; s.fake.transition({ ...CHAT, busy: true });
  now = 3_000; feed.setActive(false); s.events.setVisible(false);
  now = 4_000; s.fake.transition(CHAT); s.fake.transition({ ...CHAT, busy: true });
  now = 5_000; s.events.setVisible(true); feed.setActive(true);
  expect(feed.state().windows).toMatchObject([
    { startedAt: 2_000, endedAt: 3_000, outcome: null },
    { startedAt: null, endedAt: null, joinedAt: 5_000 },
  ]);
  feed.dispose(); s.events.dispose();
});

test('a missing identity or activity field stays unknown rather than becoming no chat or idle', () => {
  expect(sessionOf(null)).toBeNull();
  expect(sessionOf({ title: 'private', model: 'cloud/model' })).toEqual({ id: '', busy: null, model: 'cloud/model' });
  expect(sessionOf({ id: 'session', busy: false, model: 123 })).toEqual({ id: 'session', busy: false });
  expect(sessionOf({ id: 'x'.repeat(257), busy: true })).toEqual({ id: '', busy: true });
});

test('unknown activity cuts observation without inventing a completed reply', () => {
  const s = setup(); let now = 1_000;
  s.fake.ready(CHAT); s.events.setVisible(true);
  const feed = new SessionFeed(s.events, () => now, () => '1234abcd');
  now = 2_000; s.fake.transition({ ...CHAT, busy: true });
  now = 3_000; s.fake.ready({ ...CHAT, busy: null } as unknown as typeof CHAT);
  expect(feed.state()).toMatchObject({ connected: false, observedFrom: null, chat: { busy: null },
    windows: [{ startedAt: 2_000, endedAt: 3_000, outcome: null }] });
  expect(feed.drainMarks().map(mark => mark.phase)).toEqual(['started']);
  now = 4_000; s.fake.session({ ...CHAT, busy: true });
  expect(feed.state().windows.at(-1)).toMatchObject({ startedAt: null, joinedAt: 4_000, endedAt: null });
  feed.dispose(); s.events.dispose();
});

test('synchronous replay disposal leaves no SDK subscriptions behind', () => {
  const s = setup(); s.fake.ready(CHAT);
  s.events.onSession(() => s.events.dispose());
  s.events.setVisible(true);
  expect(s.live).toEqual({ session: 0, lifecycle: 0 });
  expect(s.calls).toEqual({ session: 1, lifecycle: 0 });
});

test('new consumers see the current session and cannot replay a preceding activity edge', () => {
  const s = setup(); s.fake.ready(CHAT); s.events.setVisible(true);
  s.fake.session({ ...CHAT, busy: true });
  const ready: unknown[] = [], phases: unknown[] = [];
  s.events.onReady(value => ready.push(value.session));
  s.events.onSessionLifecycle(value => phases.push(value));
  expect(ready).toEqual([{ id: CHAT.id, busy: true, model: CHAT.model }]);
  expect(phases).toEqual([]);
  s.fake.lifecycle(CHAT.id, 'started');
  expect(phases).toEqual([{ sessionId: CHAT.id, phase: 'started' }]);
  s.events.dispose();
});

test('a failing session consumer cannot starve the other consumers', () => {
  const s = setup(), sessions: unknown[] = [], error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    s.events.onSession(() => { throw new Error('Fixture listener failure'); });
    s.events.onSession(value => sessions.push(value));
    s.fake.ready(CHAT); s.events.setVisible(true);
    s.fake.session({ ...CHAT, busy: true });
    expect(sessions).toHaveLength(2); expect(error).toHaveBeenCalledTimes(2);
  } finally { s.events.dispose(); error.mockRestore(); }
});

test('malformed lifecycle phases are not coerced into a valid activity edge', () => {
  const s = setup(), phases: unknown[] = [];
  s.fake.ready(CHAT); s.events.setVisible(true);
  s.events.onSessionLifecycle(value => phases.push(value));
  s.fake.lifecycle(CHAT.id, ['started'] as never);
  s.fake.lifecycle(CHAT.id, 'unknown' as never);
  expect(phases).toEqual([{ sessionId: CHAT.id, phase: 'completed' }]);
  s.fake.lifecycle(CHAT.id, 'started');
  expect(phases.at(-1)).toEqual({ sessionId: CHAT.id, phase: 'started' });
  s.events.dispose();
});
