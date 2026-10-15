import { expect, test } from 'bun:test';
import { parseSnapshotV2 } from '../src/contract/snapshot.ts';
import { mockBody, MOCK_NOW } from './testing/mock-states.ts';
import { fromSnapshot, type Reading } from './present/reading.ts';
import { PromptEta, promptEtaText } from './prompt-eta.ts';
import { ScopeState } from './state/scope-state.ts';

const sample = (offset: number, done: number, patch: (reading: Reading) => void = () => {}) => {
  const reading = fromSnapshot(parseSnapshotV2(mockBody('prefill', { now: MOCK_NOW + offset }))!);
  Object.assign(reading.request!, { prefillProcessedTokens: done, prefillTotalTokens: 10_000, prefillFraction: done / 10_000,
    prefillObservedAt: MOCK_NOW + offset, elapsedMs: offset + 1_000 });
  patch(reading); return reading;
};
const warm = (eta = new PromptEta()) => {
  eta.observe(sample(0, 4_000)); eta.observe(sample(1_000, 4_100)); eta.observe(sample(2_000, 4_200)); return eta;
};
test('uses three advancing observations and wall time, excluding any initial cached portion', () => {
  const eta = new PromptEta();
  eta.observe(sample(0, 4_000)); eta.observe(sample(1_000, 4_100)); expect(eta.ms).toBeNull();
  eta.observe(sample(2_000, 4_200)); expect(eta.ms).toBe(58_000);
  for (let i = 3; i < 30; i++) eta.observe(sample(i * 1_000, 4_000 + i * 100));
  expect(eta.ms).toBe(31_000);
});
test('duplicates cannot invent progress or count down, and stalled progress withdraws the estimate', () => {
  const eta = warm();
  eta.observe(sample(3_000, 4_200)); expect(eta.ms).toBe(58_000);
  eta.observe(sample(8_000, 4_200)); expect(eta.ms).toBeNull();
  eta.observe(sample(9_000, 4_300)); expect(eta.ms).toBeNull();
});
test('old source timestamps are not fresh merely because the frame polled again', () => {
  const eta = warm();
  eta.observe(sample(9_000, 4_200, r => { r.request!.prefillObservedAt = MOCK_NOW + 2_000; }));
  expect(eta.ms).toBeNull();
});
test('discontinuities, overlaps and held observations reset the window', () => {
  const changes: Array<(r: Reading) => void> = [
    r => { r.active = 2; }, r => { r.active = 0; }, r => { r.active = null; },
    r => { r.phase = 'decode'; }, r => { r.request!.prefillStale = true; },
    r => { r.body!.status.state = 'degraded'; }, r => { r.body = null; },
    r => { r.model = 'another model'; }, r => { r.body!.service.instance = 'another service'; },
    r => { r.link!.generation = 42; }, r => { r.request!.prefillTotalTokens = 20_000; },
    r => { r.request!.prefillProcessedTokens = 2_000; }, r => { r.request!.elapsedMs = 5; },
    r => { r.request!.prefillProcessedTokens = 10_000; }, r => { r.request!.prefillObservedAt = MOCK_NOW + 4_000; },
    r => { delete r.body!.capabilities['request.prefillProgress']; },
  ];
  for (const change of changes) { const eta = warm(); eta.observe(sample(3_000, 4_300, change)); expect(eta.ms).toBeNull(); }
  for (const offset of [1_000, 10_000]) { const eta = warm(); eta.observe(sample(offset, 4_300)); expect(eta.ms).toBeNull(); }
});
test('same-timestamp conflicting counts restart rather than manufacture instantaneous throughput', () => {
  const eta = warm(); eta.observe(sample(2_000, 4_400)); expect(eta.ms).toBeNull();
});
test('state resets clear estimates without touching records or adding collection', () => {
  const state = new ScopeState(MOCK_NOW);
  for (let i = 0; i < 3; i++) state.accept(sample(i * 1_000, 4_000 + i * 100));
  expect(state.promptEta.ms).toBe(58_000);
  state.beginChat(MOCK_NOW + 3_000); expect(state.promptEta.ms).toBeNull();
  state.promptEta = warm(); state.clearObservations(); expect(state.promptEta.ms).toBeNull();
});
test('estimates use coarse units and never promise zero for unfinished work', () => {
  expect([100, 1000, 13_650, 60_000, 3_700_000, 90_000_000].map(promptEtaText))
    .toEqual(['Est. <1 s left', 'Est. 5 s left', 'Est. 15 s left', 'Est. 1 min left', 'Est. 2 hr left', 'Est. >24 hr left']);
});
