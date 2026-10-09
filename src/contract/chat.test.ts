import { describe, expect, test } from 'bun:test';
import { parseChatMeasurement, type ChatMeasurement } from './chat.ts';
import { parseSnapshotV2 } from './snapshot.ts';
import { fullSnapshot } from './testing/full.ts';

const live: ChatMeasurement = {
  scope: 'chat', basis: 'estimated-characters', phase: 'generating', timingBasis: 'delivery-window',
  tokensPerSecond: 42, freshness: 'live', observation: { startedAtMs: 100_000, endedAtMs: 102_000 },
  observedAtMs: 102_000, expiresAtMs: 107_000,
};
describe('optional chat measurement extension', () => {
  test('allowlists live metadata and drops unknown fields', () => {
    expect(parseChatMeasurement({ ...live, sessionKey: 'private', text: 'private' }, 102_000)).toEqual(live);
    expect(parseChatMeasurement({ ...live, basis: 'calibrated-characters', calibrationSteps: 3 }, 102_000)?.basis).toBe('calibrated-characters');
  });
  test('rejects invalid clocks, stale windows and contradictory measurement labels', () => {
    for (const change of [
      { scope: 'engine' }, { phase: 'decode' }, { tokensPerSecond: Infinity }, { tokensPerSecond: -1 },
      { observedAtMs: 108_000 }, { expiresAtMs: 102_000 }, { expiresAtMs: 120_000 },
      { observation: { startedAtMs: 101_000, endedAtMs: 102_000 } },
      { observation: { startedAtMs: 90_000, endedAtMs: 102_000 } },
      { observation: { startedAtMs: 103_000, endedAtMs: 102_000 } },
      { observation: { startedAtMs: 100_000, endedAtMs: 103_000 } },
      { phase: 'tool' }, { phase: 'waiting' }, { phase: 'cancelled' }, { freshness: 'last' },
      { basis: 'reported-output' }, { basis: 'calibrated-characters' }, { calibrationSteps: 3 },
      { basis: 'calibrated-characters', calibrationSteps: 2 }, { basis: 'calibrated-characters', calibrationSteps: 11 },
      { calibrationSteps: '3' },
    ]) expect(parseChatMeasurement({ ...live, ...change }, 102_000)).toBeNull();
    expect(parseChatMeasurement(live, 107_000)).toBeNull();
  });
  test('short replies can have a completed-step average; quiet states contain no speed', () => {
    const complete = { ...live, phase: 'complete', freshness: 'last', timingBasis: 'completed-step', basis: 'reported-output',
      observation: { startedAtMs: 101_500, endedAtMs: 102_000 }, expiresAtMs: 117_000 };
    expect(parseChatMeasurement(complete, 110_000)?.phase).toBe('complete');
    for (const phase of ['waiting', 'tool', 'cancelled']) expect(parseChatMeasurement({ ...live, phase, tokensPerSecond: undefined })?.tokensPerSecond).toBeUndefined();
  });
  test('snapshot accepts absent extension and strips stale optional data without losing runtime telemetry', () => {
    const snapshot = fullSnapshot();
    expect(parseSnapshotV2(snapshot)?.chat).toBeUndefined();
    const current = { ...snapshot, serverNow: 102_000, chat: live };
    expect(parseSnapshotV2(current)?.chat).toEqual(live);
    expect(parseSnapshotV2({ ...current, serverNow: 107_000 })?.chat).toBeNull();
  });
});
