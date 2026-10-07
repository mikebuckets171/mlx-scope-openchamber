import { afterEach, expect, test } from 'bun:test';
import { parseSnapshotV2, type SnapshotV2 } from '../../src/contract/snapshot.ts';
import { SnapshotClient } from '../data/client.ts';
import type { Visibility } from '../data/visibility.ts';
import { fromSnapshot, type Reading } from '../present/reading.ts';
import { ScopeState } from '../state/scope-state.ts';
import { MOCK_NOW, mockBody } from '../testing/mock-states.ts';
import { Monitor } from './monitor.ts';

const cleanup: Monitor[] = [];
afterEach(() => {
  for (const monitor of cleanup.splice(0)) { monitor.poller.stop(); monitor.clearFreshness(); }
});
const harness = () => {
  const clock = { at: MOCK_NOW, visible: true }, state = new ScopeState(clock.at), received: Reading[] = [];
  const client = new SnapshotClient({ serviceRequest: async () => { throw new Error('test does not poll'); } }, () => clock.at);
  const monitor = new Monitor({ state, client, frame: 'a1b2c3d4', visibility: () => ({ visible: clock.visible } as Visibility),
    tier: 'full', floorMs: 3_000, query: () => ({}), received: reading => received.push(reading), hidden() {}, render() {}, refreshed() {} });
  cleanup.push(monitor);
  return { monitor, clock, state, received };
};
const splash = (at: number, windowMs = 4_000, provider = 'splash'): Reading => {
  const body = parseSnapshotV2(mockBody('splash-decode', { now: at }))!;
  body.connection.id = provider;
  body.runtime.sampledAt = at;
  body.runtime.server.rates!.windowMs = windowMs;
  return fromSnapshot(body);
};

test.each(['pause', 'hide'])('a short %s clears this frame’s recent window while preserving other measurements', kind => {
  const { monitor, clock, state, received } = harness();
  monitor.apply(splash(clock.at));
  expect(state.signal.points).toHaveLength(1);
  if (kind === 'pause') state.userPaused = true; else clock.visible = false;
  monitor.sync();
  clock.at += 500;
  if (kind === 'pause') state.userPaused = false; else clock.visible = true;
  monitor.sync();
  const oldWindow = splash(clock.at), original = oldWindow.body!;
  monitor.apply(oldWindow);
  expect(state.snapshot!.runtime.server.rates).toBeUndefined();
  expect(state.snapshot!.capabilities['server.rates']).toBeUndefined();
  expect(state.signal.points).toHaveLength(1);
  expect(received.at(-1)!.body!.runtime.server.rates).toBeUndefined();
  expect(state.snapshot!.runtime.server.averages).toEqual(original.runtime.server.averages);
  expect(state.snapshot!.completions).toBe(original.completions);
  expect(state.snapshot!.host).toBe(original.host);
  expect(state.latest.splash).toEqual(oldWindow.splash);
  // The shared service reading can still be used by another visible frame.
  expect(original.runtime.server.rates).toEqual({ decodeTps: 43.8, windowMs: 4_000 });
  expect(original.capabilities['server.rates']).toEqual({ scope: 'server', basis: 'derived' });

  // An older service's short window must not release the boundary before the new observation is eligible.
  monitor.apply(splash(clock.at + 1_000, 1_000));
  expect(state.snapshot!.runtime.server.rates).toBeUndefined();

  clock.at += 2_499;
  monitor.apply(splash(clock.at, 2_500));
  expect(state.snapshot!.runtime.server.rates).toBeUndefined();
  clock.at += 1;
  monitor.apply(splash(clock.at, 2_500));
  expect(state.snapshot!.runtime.server.rates).toEqual({ decodeTps: 43.8, windowMs: 2_500 });
  expect(state.signal.points).toHaveLength(2);
});

test('A → B → A requires each returned connection’s whole window to follow the switch', () => {
  const { monitor, state } = harness();
  monitor.apply(splash(MOCK_NOW));
  monitor.apply(splash(MOCK_NOW + 500, 4_000, 'other'));
  expect(state.snapshot!.runtime.server.rates).toBeUndefined();
  monitor.apply(splash(MOCK_NOW + 1_000));
  expect(state.snapshot!.runtime.server.rates).toBeUndefined();
  expect(state.signal.points).toEqual([]);
  monitor.apply(splash(MOCK_NOW + 3_000, 2_000));
  expect(state.snapshot!.runtime.server.rates).toEqual({ decodeTps: 43.8, windowMs: 2_000 });
  expect(state.signal.points).toHaveLength(1);
});

test('a paused frame does not invalidate a continuously visible frame or other runtimes', () => {
  const paused = harness(), visible = harness(), shared = splash(MOCK_NOW + 500);
  paused.monitor.apply(splash(MOCK_NOW)); visible.monitor.apply(splash(MOCK_NOW));
  paused.state.userPaused = true; paused.monitor.sync();
  paused.clock.at += 500; paused.state.userPaused = false; paused.monitor.sync();
  paused.monitor.apply(shared); visible.monitor.apply(shared);
  expect(paused.state.snapshot!.runtime.server.rates).toBeUndefined();
  expect(visible.state.snapshot!.runtime.server.rates).toEqual(shared.body!.runtime.server.rates);
  const omlx = parseSnapshotV2(mockBody('decode', { now: MOCK_NOW + 1_000 }))! as SnapshotV2;
  paused.monitor.apply(fromSnapshot(omlx));
  expect(paused.state.snapshot).toBe(omlx);
  expect(paused.state.latest.request?.decodeTps).toBe(omlx.runtime.request!.decodeTps);
});

test.each(['prefill', 'generation'])('qualifying %s does not release the other stage’s older window after pause', first => {
  const { monitor, clock, state } = harness();
  monitor.apply(splash(clock.at)); state.userPaused = true; monitor.sync();
  clock.at += 500; state.userPaused = false; monitor.sync();
  const mixed = (elapsed: number): Reading => {
    const reading = splash(clock.at + elapsed, first === 'generation' ? 2_000 : 4_000);
    reading.body!.runtime.phase = 'processing';
    Object.assign(reading.body!.runtime.server.rates!, { promptTps: 600, promptWindowMs: first === 'prefill' ? 2_000 : 4_000 });
    return reading;
  };
  const shared = mixed(2_000);
  monitor.apply(shared);
  expect(state.snapshot!.runtime.server.rates).toEqual(first === 'generation'
    ? { decodeTps: 43.8, windowMs: 2_000 }
    : { promptTps: 600, promptWindowMs: 2_000, windowMs: 2_000 });
  monitor.apply(mixed(3_000));
  expect(first === 'generation' ? state.snapshot!.runtime.server.rates?.promptTps : state.snapshot!.runtime.server.rates?.decodeTps).toBeUndefined();
  monitor.apply(mixed(4_000));
  expect(state.snapshot!.runtime.server.rates).toMatchObject({ decodeTps: 43.8, promptTps: 600 });
  expect(shared.body!.runtime.server.rates).toMatchObject({ decodeTps: 43.8, promptTps: 600 });
});

test('a fresh status cannot restore prompt progress collected before this frame resumed', () => {
  const { monitor, clock, state } = harness();
  monitor.apply(splash(clock.at)); state.userPaused = true; monitor.sync();
  clock.at += 500; state.userPaused = false; monitor.sync();
  const progress = (observedAt: number, withRate = false): Reading => {
    const reading = splash(clock.at + 4_000);
    reading.body!.runtime.phase = 'prefill';
    if (!withRate) delete reading.body!.runtime.server.rates;
    else reading.body!.runtime.server.rates = { promptTps: 612, promptWindowMs: 3_200, windowMs: 3_200 };
    reading.body!.runtime.request = { model: 'Example-27B', prefillFraction: .64, prefillProcessedTokens: 64,
      prefillTotalTokens: 100, prefillObservedAt: observedAt };
    reading.body!.capabilities['request.prefillProgress'] = { scope: 'request', basis: 'reported' };
    return fromSnapshot(reading.body!);
  };
  const cached = progress(clock.at - 500);
  monitor.apply(cached);
  expect(state.snapshot!.runtime.request).toEqual({ model: 'Example-27B' });
  expect(state.latest.request?.prefillFraction).toBeUndefined();
  expect(state.snapshot!.capabilities['request.prefillProgress']).toBeUndefined();
  expect(cached.body!.runtime.request!.prefillFraction).toBe(.64);
  expect(cached.body!.capabilities['request.prefillProgress']).toBeDefined();

  // A qualified speed is independent evidence and cannot release the progress watermark.
  monitor.apply(progress(clock.at - 500, true));
  expect(state.snapshot!.runtime.server.rates?.promptTps).toBe(612);
  expect(state.snapshot!.runtime.request?.prefillFraction).toBeUndefined();
  monitor.apply(progress(clock.at));
  expect(state.snapshot!.runtime.request?.prefillFraction).toBe(.64);
  expect(state.latest.request?.prefillObservedAt).toBe(clock.at);
  expect(state.snapshot!.capabilities['request.prefillProgress']).toBeDefined();
});

test('switching connections suppresses cached progress without leaving an empty request', () => {
  const { monitor, state } = harness();
  monitor.apply(splash(MOCK_NOW));
  const body = splash(MOCK_NOW + 500, 4_000, 'other').body!;
  body.runtime.phase = 'prefill'; delete body.runtime.server.rates;
  body.runtime.request = { model: null, prefillFraction: .64, prefillObservedAt: MOCK_NOW };
  body.capabilities['request.prefillProgress'] = { scope: 'request', basis: 'reported' };
  monitor.apply(fromSnapshot(body));
  expect(state.snapshot!.runtime.request).toBeNull();
  expect(state.latest.request).toBeNull();
  expect(state.snapshot!.capabilities['request.prefillProgress']).toBeUndefined();
});
