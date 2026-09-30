import { expect, test } from 'bun:test';
import { MARK_DEDUPE_MS, MARK_FUTURE_MS, MARK_PAST_MS, MARK_RING, Marks } from './marks.ts';
import { Verdicts, VERDICT_LIMIT } from './verdicts.ts';
import { COMPLETION_RING } from '../history/completions.ts';
import { HISTORY_SLOTS } from '../history/history.ts';

const NOW = 1_790_690_700_000;
const mark = (phase: 'started' | 'completed' | 'failure', at: number, tag = 'aaaaaaaa') => ({ phase, at, tag });

test('marks are deduplicated by tag, phase and 1 s, in a ring of 64 whose head only grows', () => {
  const marks = new Marks();
  expect(marks.head).toBe(0);
  marks.record([mark('started', NOW - 5_000), mark('started', NOW - 5_000 + MARK_DEDUPE_MS), mark('started', NOW - 5_000, 'bbbbbbbb')], NOW);
  expect(marks.head).toBe(2);
  marks.record([mark('started', NOW - 5_000 - MARK_DEDUPE_MS - 1), mark('completed', NOW - 5_000)], NOW);
  expect(marks.entries()).toEqual([{ seq: 1, at: NOW - 5_000, phase: 'started' }, { seq: 2, at: NOW - 5_000, phase: 'started' },
    { seq: 3, at: NOW - 6_001, phase: 'started' }, { seq: 4, at: NOW - 5_000, phase: 'completed' }]);
  for (let index = 0; index < 100; index += 1) marks.record([mark('started', NOW - 300_000 + index * 2_000)], NOW);
  expect(marks.head).toBe(104);
  expect(marks.entries()).toHaveLength(MARK_RING);
  expect(marks.entries()[0]!.seq).toBe(104 - MARK_RING + 1);
  expect(JSON.stringify(marks.entries())).not.toContain('aaaaaaaa');
});

test('marks outside the trend window or ahead of the service clock are not stored', () => {
  const marks = new Marks();
  marks.record([mark('started', NOW - MARK_PAST_MS - 1), mark('started', NOW + MARK_FUTURE_MS + 1)], NOW);
  expect(marks.head).toBe(0);
  marks.record([mark('started', NOW - MARK_PAST_MS), mark('completed', NOW + MARK_FUTURE_MS)], NOW);
  expect(marks.head).toBe(2);
});

test('verdicts: only for assigned seqs, the first stands, an armed capture replaces it, and one per completion the rings can hold', () => {
  const verdicts = new Verdicts();
  verdicts.record([{ seq: 3, attr: 'inferred', reason: null }, { seq: 4, attr: 'withheld', reason: 'overlap' }], NOW, 3);
  expect([verdicts.get(3), verdicts.get(4)]).toEqual([{ attr: 'inferred', at: NOW }, undefined]);
  verdicts.record([{ seq: 3, attr: 'withheld', reason: 'several-chats' }], NOW + 1, 4);
  expect(verdicts.get(3)).toEqual({ attr: 'inferred', at: NOW });
  verdicts.record([{ seq: 3, attr: 'armed', reason: null }, { seq: 4, attr: 'withheld', reason: 'overlap' }], NOW + 2, 4);
  expect([verdicts.get(3), verdicts.get(4)]).toEqual([{ attr: 'armed', at: NOW + 2 }, { attr: 'withheld', reason: 'overlap', at: NOW + 2 }]);
  verdicts.record([{ seq: 3, attr: 'armed', reason: null }], NOW + 3, 4);
  expect(verdicts.get(3)?.at).toBe(NOW + 2);
  verdicts.record(Array.from({ length: VERDICT_LIMIT }, (_, index) => ({ seq: 5_000 - index, attr: 'inferred' as const, reason: null })), NOW, 5_000);
  // The oldest completions leave first.
  expect([verdicts.get(3), verdicts.get(4), verdicts.get(5_000 - VERDICT_LIMIT + 1)]).toEqual([undefined, undefined, { attr: 'inferred', at: NOW }]);
  expect(VERDICT_LIMIT).toBe(COMPLETION_RING * HISTORY_SLOTS);
});
