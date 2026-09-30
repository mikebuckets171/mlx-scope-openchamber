import { expect, test } from 'bun:test';
import { parseSnapshotV2 } from '../../src/contract/snapshot.ts';
import { fromSnapshot } from '../present/reading.ts';
import { SERVER_WIDE } from '../present/scope.ts';
import { MOCK_NOW, mockBody } from '../testing/mock-states.ts';
import { Pipeline } from './pipeline.ts';
import { ScopeState } from './scope-state.ts';

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
  expect([pipeline.turn(), pipeline.chatRuntime(), pipeline.firstRun, pipeline.nextState]).toEqual([null, null, false, { kind: 'idle' }]);
  pipeline.hidden();
  expect(calls.filter(call => call === 'set')).toEqual([]);
  pipeline.dispose();
});
