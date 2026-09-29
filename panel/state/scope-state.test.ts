import { expect, test } from 'bun:test';
import { fromSnapshot, frameReading, type Reading } from '../present/reading.ts';
import { v2Body } from '../testing/readings.ts';
import { ScopeState } from './scope-state.ts';

const last = { model: 'fixture', tokensPerSecond: 38.6, ttftSeconds: 0.5, promptTokens: 100, cachedTokens: 60, outputTokens: 20, finishedAt: 900 };
const bionic = (extra: Record<string, unknown> = {}) => v2Body({ available: true, runtime: 'lmstudio', phase: 'idle', sampledAt: 1_000, lastRequest: last,
  connection: { selected: 'bionic', label: 'Bionic', runtime: 'lmstudio', choices: [], diagnostic: 'ready', coverage: 'requests', generation: '00000000-0000-4000-8000-000000000001' }, ...extra });
const withCompletions = (body: ReturnType<typeof bionic>, change: Partial<ReturnType<typeof bionic>['completions']>): Reading =>
  fromSnapshot({ ...body, completions: { ...body.completions, ...change } });

test('the newest completion survives polls that carry only newer items, and is dropped when the ring restarts', () => {
  const state = new ScopeState(0), body = bionic();
  expect(state.since).toBeUndefined();
  state.accept(fromSnapshot(body));
  expect(state.lastRequest).toMatchObject({ seq: 1, decodeTps: 38.6, ttftMs: 500 });
  expect(state.since).toBe(1);
  state.accept(withCompletions(body, { items: [] }));
  expect(state.lastRequest?.seq).toBe(1);
  // Unavailable readings never show it, but it returns with the next reading.
  state.accept(frameReading('host_timeout', null, 2_000));
  expect(state.lastRequest).toBeNull();
  state.accept(withCompletions(body, { items: [] }));
  expect(state.lastRequest?.seq).toBe(1);
  for (const change of [{ items: [], cursor: 0 }, { items: [], reset: true }, { items: [], instance: 'ffffffff', cursor: 1 }]) {
    const fresh = new ScopeState(0);
    fresh.accept(fromSnapshot(body));
    fresh.accept(fromSnapshot({ ...body, service: { ...body.service, instance: change.instance ?? body.service.instance }, completions: { ...body.completions, ...change } }));
    expect(fresh.lastRequest).toBeNull();
  }
});

test('a reading from another connection asks for the observations to be cleared first', () => {
  const state = new ScopeState(0), first = fromSnapshot(bionic());
  expect(state.isNewConnection(first)).toBe(false);
  state.accept(first);
  expect(state.last).toBe(first); expect(state.lastHost).toBeNull();
  expect(state.isNewConnection(fromSnapshot(bionic({ sampledAt: 1_500 })))).toBe(false);
  const recreated = fromSnapshot(bionic({ connection: { selected: 'bionic', label: 'Bionic', runtime: 'lmstudio', choices: [], diagnostic: 'ready',
    coverage: 'requests', generation: '00000000-0000-4000-8000-000000000002' } }));
  expect(state.isNewConnection(recreated)).toBe(true);
  // Frame-side states name no connection and never clear anything.
  expect(state.isNewConnection(frameReading('runtime_unreachable', null, 3_000))).toBe(false);
  state.clearObservations();
  expect([state.last, state.lastHost, state.lastRequest, state.since, state.isNewConnection(recreated)]).toEqual([null, null, null, undefined, false]);
});
