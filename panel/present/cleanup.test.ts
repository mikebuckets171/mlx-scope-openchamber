import { expect, test } from 'bun:test';
import { parseSnapshotV2 } from '../../src/contract/snapshot.ts';
import { MOCK_NOW, mockBody } from '../testing/mock-states.ts';
import { presentLive } from './live.ts';
import { fromSnapshot } from './reading.ts';
import type { ScopeInput } from './scope.ts';

const fixture = (patch: (body: any) => void = () => {}): ScopeInput => {
  const body = structuredClone(mockBody('decode'));
  patch(body);
  const snapshot = parseSnapshotV2(body)!;
  expect(snapshot).not.toBeNull();
  return { now: MOCK_NOW, version: '2.1.1', snapshot, fresh: true, frame: null, paused: false,
    attribution: { kind: 'inferred' }, chatRuntime: null, last: null, samples: [], turnStartAt: null };
};
test('first-token provenance is independent of token-count capability and omitted when unsupported', () => {
  const input = fixture(body => {
    body.capabilities['request.ttft'] = { scope: 'request', basis: 'observed' };
    body.runtime.request.ttftMs = 420;
    delete body.capabilities['request.tokens'];
    body.runtime.request.promptTokens = null;
    body.runtime.request.cachedTokens = null;
    body.runtime.request.outputTokens = null;
  });
  expect(presentLive(input).hero?.firstToken).toEqual({ text: 'First token', strong: '0.42 s', basis: 'observed' });
  expect(presentLive(fixture()).hero?.firstToken).toBeNull();
});

test('current and last-reply timings never substitute for one another', () => {
  const input = fixture();
  const completion = structuredClone(input.snapshot!.completions.items.at(-1)!);
  completion.ttftMs = 840; completion.basis = 'reported';
  input.last = { completion, label: { kind: 'inferred' }, vsUsual: null, flag: null };
  expect(presentLive(input).hero?.firstToken).toBeNull();
  expect(presentLive(input).hero?.reply?.values).toContainEqual({ text: 'First token', strong: '0.84 s', basis: 'reported' });
});
