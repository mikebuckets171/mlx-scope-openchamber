import { expect, test } from 'bun:test';
import { backoffMs, failuresOf, initialSlot, redetectDue, stepSlot, type SlotEvent, type SlotState } from './slot.ts';

const run = (events: Array<[SlotEvent, number]>, from: SlotState = initialSlot(0)): SlotState[] => {
  const states: SlotState[] = [];
  let state = from;
  for (const [event, at] of events) states.push(state = stepSlot(state, event, at));
  return states;
};
const unreachable: SlotEvent = { kind: 'failed', reason: 'runtime_unreachable' };
const unsupported: SlotEvent = { kind: 'degraded', unsupported: true };

test('detecting → ready ⇄ degraded → failing(n), keeping the time each state began', () => {
  expect(run([[{ kind: 'ready' }, 10], [{ kind: 'ready' }, 20], [{ kind: 'degraded' }, 30], [{ kind: 'ready' }, 40], [unreachable, 50], [unreachable, 60],
    [{ kind: 'failed', reason: 'authentication_failed' }, 70], [{ kind: 'ready' }, 80]])).toEqual([
    { kind: 'ready', since: 10 }, { kind: 'ready', since: 10 }, { kind: 'degraded', since: 30, unsupported: 0 }, { kind: 'ready', since: 40 },
    { kind: 'failing', since: 50, failures: 1, reason: 'runtime_unreachable', streak: 1 },
    { kind: 'failing', since: 50, failures: 2, reason: 'runtime_unreachable', streak: 2 },
    { kind: 'failing', since: 50, failures: 3, reason: 'authentication_failed', streak: 1 },
    { kind: 'ready', since: 80 },
  ]);
  expect(initialSlot(5)).toEqual({ kind: 'detecting', since: 5 });
  expect(stepSlot({ kind: 'ready', since: 1 }, { kind: 'redetect' }, 9)).toEqual({ kind: 'detecting', since: 9 });
});

test('an unsupported reading is degraded, never failing, and counts in a row without a backoff', () => {
  const states = run([[{ kind: 'degraded' }, 1], [unsupported, 2], [unsupported, 3], [{ kind: 'degraded' }, 4], [unsupported, 5]]);
  expect(states.map(state => state.kind === 'degraded' ? [state.since, state.unsupported] : state.kind)).toEqual([[1, 0], [1, 1], [1, 2], [1, 0], [1, 1]]);
  expect(states.map(failuresOf)).toEqual([0, 0, 0, 0, 0]);
  expect(run([[unsupported, 7]])).toEqual([{ kind: 'degraded', since: 7, unsupported: 1 }]);
});

test('one backoff: min(8 s, 0.5 s · 2ⁿ), none while healthy', () => {
  expect([0, 1, 2, 3, 4, 5, 6, 40].map(backoffMs)).toEqual([0, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000]);
  const states = run([[unreachable, 1], [unreachable, 2], [{ kind: 'failed', reason: 'unsupported_runtime' }, 3]]);
  expect(states.map(failuresOf)).toEqual([1, 2, 3]);
  expect(failuresOf({ kind: 'degraded', since: 0, unsupported: 5 })).toBe(0);
});

test('re-detection is due on the third unsupported reading in a row, or the first answer after 30 s unreachable', () => {
  const states = run([[unsupported, 1], [unsupported, 2], [unsupported, 3], [unsupported, 4]]);
  const due = states.map((state, index) => redetectDue(index ? states[index - 1]! : initialSlot(0), state, index + 1));
  expect(due).toEqual([false, false, true, false]);
  // A pass resets the slot: three more unsupported readings are needed before the next one.
  const after = run([[{ kind: 'redetect' }, 5], [unsupported, 6], [unsupported, 7], [unsupported, 8]]);
  expect(redetectDue(after[2]!, after[3]!, 8)).toBe(true);
  // A supported reading in between restarts the count.
  const mixed = run([[unsupported, 1], [unsupported, 2], [{ kind: 'ready' }, 3], [unsupported, 4]]);
  expect(mixed.at(-1)).toEqual({ kind: 'degraded', since: 4, unsupported: 1 });
  const down = run([[unreachable, 1_000], [unreachable, 20_000]]).at(-1)!;
  expect(redetectDue(down, stepSlot(down, { kind: 'ready' }, 30_999), 30_999)).toBe(false);
  expect(redetectDue(down, stepSlot(down, { kind: 'ready' }, 31_000), 31_000)).toBe(true);
  expect(redetectDue(down, stepSlot(down, { kind: 'degraded' }, 60_000), 60_000)).toBe(true);
  expect(redetectDue(down, stepSlot(down, unreachable, 60_000), 60_000)).toBe(false);
  const rejected = run([[{ kind: 'failed', reason: 'authentication_failed' }, 0]]).at(-1)!;
  expect(redetectDue(rejected, stepSlot(rejected, { kind: 'ready' }, 90_000), 90_000)).toBe(false);
});
