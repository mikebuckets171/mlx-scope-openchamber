import { expect, test } from 'bun:test';
import { fromSnapshot, frameReading, type Reading } from '../present/reading.ts';
import { v2Body } from '../testing/readings.ts';
import { ScopeState } from './scope-state.ts';
import type { ChatMeasurement } from '../../src/contract/chat.ts';

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
  // A finished reply stays through a poll without a body: it carries its own time (2.0: Last reply survives offline).
  state.accept(frameReading('host_timeout', null, 2_000));
  expect(state.lastRequest?.seq).toBe(1);
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
  expect(state.snapshot).toBe(first.body); expect(state.lastHost).toBeNull();
  expect(state.isNewConnection(fromSnapshot(bionic({ sampledAt: 1_500 })))).toBe(false);
  // v2 bumps connection.generation on a connection change, re-detection or an LM Studio model state change.
  const body = bionic(), recreated = fromSnapshot({ ...body, connection: { ...body.connection, generation: body.connection.generation + 1 } });
  expect(state.isNewConnection(recreated)).toBe(true);
  // Frame-side states name no connection and never clear anything.
  expect(state.isNewConnection(frameReading('runtime_unreachable', null, 3_000))).toBe(false);
  state.clearObservations();
  expect([state.snapshot, state.lastHost, state.lastRequest, state.since, state.isNewConnection(recreated)]).toEqual([null, null, null, undefined, false]);
});

test('fresh completions are returned once and kept in order (coverage is attribution\'s ActivityTrack)', () => {
  const state = new ScopeState(0), body = bionic();
  expect(state.accept(fromSnapshot(body)).map(item => item.seq)).toEqual([1]);
  expect(state.accept(fromSnapshot(body))).toEqual([]);
  const second = { ...body.completions.items[0]!, seq: 2, finishedAt: 1_900 };
  expect(state.accept(fromSnapshot({ ...body, serverNow: 2_000, completions: { ...body.completions, cursor: 2, items: [second] } })).map(item => item.seq)).toEqual([2]);
  expect(state.recent.map(item => item.seq)).toEqual([1, 2]);
});

test('a frame back from hidden pages through a backlog of 65–128 completions to the newest', () => {
  const state = new ScopeState(0), body = bionic(), item = body.completions.items[0]!;
  // The service's ring after 100 replies finished while the frame was hidden: items after `since`, oldest first, ≤ 64.
  const ring = Array.from({ length: 101 }, (_, index) => ({ ...item, seq: index + 1, finishedAt: 900 + index }));
  const poll = (since: number): Reading => withCompletions(body, { cursor: 101, items: ring.filter(entry => entry.seq > since).slice(0, 64) });
  state.accept(withCompletions(body, { cursor: 1, items: ring.slice(0, 1) }));
  expect(state.accept(poll(state.since!)).map(entry => entry.seq)).toEqual(ring.slice(1, 65).map(entry => entry.seq));
  expect(state.since).toBe(65);
  expect(state.accept(poll(state.since!)).map(entry => entry.seq)).toEqual(ring.slice(65).map(entry => entry.seq));
  expect([state.lastRequest?.seq, state.since, state.recent.length, state.recent[0]?.seq]).toEqual([101, 101, 64, 38]);
  // A recording leader's held-back `since` brings a full page the frame already kept: its cursor never goes back.
  expect(state.accept(poll(20))).toEqual([]);
  expect([state.since, state.recent.length]).toEqual([101, 64]);
});

const completedChat = (at: number): ChatMeasurement => ({ scope: 'chat', phase: 'complete', freshness: 'last',
  basis: 'reported-output', timingBasis: 'completed-step', tokensPerSecond: 20,
  observedAtMs: at, expiresAtMs: at + 15_000, observation: { startedAtMs: at - 3_000, endedAtMs: at } });
const chatReading = (at: number, chat?: ChatMeasurement): Reading => fromSnapshot({ ...bionic(), serverNow: at, chat });

test('one completed chat result survives private telemetry expiry only in frame memory', () => {
  const state = new ScopeState(0), result = completedChat(10_000);
  state.accept(chatReading(10_000, result));
  state.accept(chatReading(30_000));
  expect(state.lastChat).toEqual(result);
  expect(state.snapshot?.chat).toBeUndefined();
  state.clearObservations();
  expect(state.lastChat).toBeNull();
});

test('new reply boundaries reject an old in-flight completion and accept the later result', () => {
  const state = new ScopeState(0), old = completedChat(10_000);
  state.accept(chatReading(10_000, old));
  state.beginChat(11_000);
  expect(state.lastChat).toBeNull();
  expect(state.snapshot?.chat).toBeUndefined();
  state.accept(chatReading(12_000, old));
  expect(state.lastChat).toBeNull();
  expect(state.snapshot?.chat).toBeUndefined();
  state.accept(chatReading(15_000, completedChat(15_000)));
  expect(state.lastChat?.observedAtMs).toBe(15_000);
});

test('quiet lifecycle events, ineligible completion and service restart clear a retained result', () => {
  for (const phase of ['waiting', 'tool', 'cancelled', 'generating', 'reasoning'] as const) {
    const state = new ScopeState(0);
    state.accept(chatReading(10_000, completedChat(10_000)));
    state.accept(chatReading(11_000, { ...completedChat(11_000), phase, freshness: 'live', basis: 'estimated-characters',
      timingBasis: 'delivery-window', tokensPerSecond: undefined, expiresAtMs: 16_000 }));
    expect(state.lastChat, phase).toBeNull();
  }
  const state = new ScopeState(0);
  state.accept(chatReading(10_000, completedChat(10_000)));
  state.accept(chatReading(11_000, { ...completedChat(11_000), tokensPerSecond: undefined }));
  expect(state.lastChat).toBeNull();
  state.accept(chatReading(12_000, completedChat(12_000)));
  const reading = chatReading(13_000);
  reading.body!.service.instance = 'ffffffff';
  state.accept(reading);
  expect(state.lastChat).toBeNull();
});

test('expired or future completions cannot establish a retained chat result', () => {
  for (const at of [1_000, 50_000]) {
    const state = new ScopeState(0);
    state.accept(chatReading(30_000, completedChat(at)));
    expect(state.lastChat).toBeNull();
  }
});
