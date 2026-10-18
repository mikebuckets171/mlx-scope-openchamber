import { expect, test } from 'bun:test';
import type { CompletionV2 } from '../../src/contract/completion.ts';
import { parseSnapshotV2 } from '../../src/contract/snapshot.ts';
import { baselineStore, buildBaselines } from '../history/baselines.ts';
import { KEYS, replyRow } from '../history/ledger-schema.ts';
import { fromSnapshot } from '../present/reading.ts';
import { SERVER_WIDE } from '../present/scope.ts';
import { MOCK_NOW, mockBody } from '../testing/mock-states.ts';
import { Pipeline } from './pipeline.ts';
import { ScopeState } from './scope-state.ts';
import type { SessionSnapshot, SessionLifecycleEvent } from '@openchamber/sdk';

// The pipeline codes against the attribution and ledger interfaces; with their stubs it must stay inert and honest.
const host = () => {
  const calls: string[] = [];
  return { calls, host: { onSession: () => () => {}, onSessionLifecycle: () => () => {},
    storage: { get: async () => { calls.push('get'); return undefined; }, set: async () => { calls.push('set'); }, delete: async () => {}, keys: async () => [] },
    setBadge: async () => { calls.push('badge'); }, toast: async () => { calls.push('toast'); } } };
};

test('a frame with nothing to send sends no mark or attr, labels nothing it did not observe, and writes nothing while idle', () => {
  const { host: h, calls } = host(), state = new ScopeState(MOCK_NOW);
  const pipeline = new Pipeline({ host: h, state, now: () => MOCK_NOW, surface: 'panel', toasts: () => 'critical', auto: () => true });
  expect(pipeline.query()).toEqual({});
  const snapshot = parseSnapshotV2(JSON.parse(JSON.stringify(mockBody('idle'))))!, fresh = state.accept(fromSnapshot(snapshot));
  expect(() => pipeline.received(snapshot, fresh, true)).not.toThrow();
  // The service's recorded verdict is the label; without one, the frame never invents "This chat".
  expect(pipeline.label(fresh[0]!)).toEqual({ kind: 'inferred' });
  expect(pipeline.label({ ...fresh[0]!, verdict: undefined })).toEqual(SERVER_WIDE);
  expect(pipeline.liveLabel(snapshot)).toEqual(SERVER_WIDE);
  expect([pipeline.turn(), pipeline.chatRuntime(), pipeline.firstRun]).toEqual([null, null, false]);
  pipeline.hidden();
  expect(calls.filter(call => call === 'set')).toEqual([]);
  pipeline.dispose();
});

test('a started lifecycle clears the previous result before the busy snapshot arrives, without replaying the boundary', () => {
  let now = MOCK_NOW, onSession: (session: SessionSnapshot | null) => void = () => {}, onLifecycle: (event: SessionLifecycleEvent) => void = () => {};
  const { host: h } = host(), state = new ScopeState(now);
  const source = { ...h,
    onSession: (listener: typeof onSession) => { onSession = listener; return () => {}; },
    onSessionLifecycle: (listener: typeof onLifecycle) => { onLifecycle = listener; return () => {}; } };
  let changes = 0;
  const pipeline = new Pipeline({ host: source, state, now: () => now, surface: 'panel', toasts: () => 'off', auto: () => true, changed: () => { changes++; } });
  const snapshot = parseSnapshotV2(structuredClone(mockBody('idle')))!;
  state.accept(fromSnapshot(snapshot)); pipeline.received(snapshot, [], true);
  onSession({ id: 'fixture-chat', title: '', busy: false, model: 'fixture/model' });
  const complete = { scope: 'chat', phase: 'complete', freshness: 'last', basis: 'reported-output', timingBasis: 'completed-step',
    tokensPerSecond: 30, observedAtMs: now, expiresAtMs: now + 15_000, observation: { startedAtMs: now - 2_000, endedAtMs: now } } as const;
  state.accept(fromSnapshot({ ...snapshot, chat: complete }));
  expect(state.lastChat).not.toBeNull();
  now += 1_000;
  onLifecycle({ sessionId: 'fixture-chat', phase: 'started' });
  expect(pipeline.frame().chat?.busy).toBe(false); // The busy snapshot has deliberately not arrived.
  expect(state.lastChat).toBeNull(); expect(state.snapshot?.chat).toBeUndefined();
  expect(changes).toBe(1);
  now += 1_000;
  const next = { ...complete, observedAtMs: now, expiresAtMs: now + 15_000,
    observation: { startedAtMs: now - 900, endedAtMs: now } };
  state.accept(fromSnapshot({ ...snapshot, serverNow: now, chat: next }));
  onLifecycle({ sessionId: 'fixture-chat', phase: 'started' });
  expect(state.lastChat).toEqual(next);
  expect(changes).toBe(1);
  onLifecycle({ sessionId: 'fixture-chat', phase: 'completed' });
  expect(changes).toBe(2);
  onLifecycle({ sessionId: 'fixture-chat', phase: 'completed' });
  expect(changes).toBe(2);
  onLifecycle({ sessionId: 'fixture-chat', phase: 'failure' });
  expect(pipeline.window()?.outcome).toBe('failure');
  expect(changes).toBe(3);
  onLifecycle({ sessionId: 'fixture-chat', phase: 'failure' });
  expect(changes).toBe(3);
  onSession({ id: 'fixture-chat-next', title: '', busy: false, model: 'fixture/model' });
  expect(pipeline.window()).toBeNull();
  pipeline.dispose();
});

test('the pipeline flags slower replies itself, with what was queued or running in memory only, and History’s rows merge without doubling', async () => {
  const snapshot = parseSnapshotV2(structuredClone(mockBody('idle')))!, template: CompletionV2 = { ...snapshot.completions.items[0]!, basis: 'reported' };
  const rt = snapshot.connection.runtime!, instance = snapshot.completions.instance, model = template.model!;
  const usual = buildBaselines(Array.from({ length: 20 }, (_, i) =>
    replyRow({ ...template, seq: 1 + i, finishedAt: MOCK_NOW - 7_200_000 - i * 60_000, decodeTps: 25 }, instance, rt, 0, 'not-observed')), MOCK_NOW);
  const stored = new Map<string, unknown>([[KEYS.baseline, baselineStore(usual, MOCK_NOW)], [KEYS.models, [model]]]);
  const { host: h } = host();
  const source = { ...h, storage: { ...h.storage, get: async (key: string) => stored.get(key) as never } };
  const pipeline = new Pipeline({ host: source, state: new ScopeState(MOCK_NOW), now: () => MOCK_NOW, surface: 'status', toasts: () => 'off', auto: () => true });
  pipeline.received(snapshot, [], true);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(pipeline.flags).toEqual([]);
  const slow = [20, 19, 21].map((decodeTps, i): CompletionV2 => ({ ...template, seq: 100 + i, finishedAt: MOCK_NOW - (3 - i) * 60_000, decodeTps,
    host: { ...template.host, queuedMax: i === 0 ? 2 : 0, mediaRunning: i === 2 } }));
  pipeline.received(snapshot, slow, true);
  expect(pipeline.flags).toEqual([expect.objectContaining({ metric: 'decodeTps', recentMedian: 20, p50: 25, cofactors: 32 | 64 })]);
  expect(pipeline.flagsFor(rt, model)).toHaveLength(1);
  expect(pipeline.flagsFor(rt, null)).toHaveLength(1);
  expect(pipeline.flagsFor(rt, 'another/model')).toEqual([]);
  expect(pipeline.flagsFor(null, model)).toEqual([]);
  // The ledger holds the same replies without the in-memory bits; the frame's own copy wins.
  const ledgerRows = slow.map(completion => replyRow(completion, instance, rt, 0, 'inferred'));
  expect(ledgerRows.every(row => row[15] < 32)).toBe(true);
  pipeline.storedReplies(ledgerRows);
  expect(pipeline.flags).toEqual([expect.objectContaining({ cofactors: 32 | 64 })]);
  pipeline.historyCleared();
  expect(pipeline.flags).toEqual([]);
  pipeline.dispose();
});
