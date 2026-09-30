import { expect, test } from 'bun:test';
import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { TurnWindow } from './sessions.ts';
import { step, T0 } from './testing.ts';
import { summarizeTurn } from './turn.ts';

const window: TurnWindow = { tag: 'aaaaaaaa', startedAt: T0, endedAt: T0 + 112_000, outcome: 'completed' };
const inferred = (value: Parameters<typeof step>[0]): CompletionV2 => step({ verdict: { attr: 'inferred', at: T0 }, ...value });
// Three steps with tool pauses between them (the mock's Bionic turn shape).
const steps = [
  inferred({ seq: 3, startedAt: T0 + 60_000, finishedAt: T0 + 90_000, outputTokens: 1_500, decodeTps: 50, promptTokens: 20_000, cachedTokens: 12_000, ttftMs: 700 }),
  inferred({ seq: 1, startedAt: T0 + 200, finishedAt: T0 + 25_200, outputTokens: 1_000, decodeTps: 25, promptTokens: 17_900, cachedTokens: 11_020, ttftMs: 520 }),
  { ...inferred({ seq: 2, startedAt: T0 + 40_000, finishedAt: T0 + 60_000, outputTokens: 604, decodeTps: 40.3, promptTokens: 16_520, cachedTokens: 10_440 }),
    verdict: { attr: 'armed' as const, at: T0 } },
];

test('a turn summary: observed wall time, model and tool time, first TTFT, totals and a token-weighted rate', () => {
  const summary = summarizeTurn(window, steps)!;
  expect(summary).toMatchObject({ wallMs: 112_000, modelMs: 25_000 + 20_000 + 30_000, toolMs: 37_000, steps: 3, firstTtftMs: 520,
    promptTokens: 54_420, cachedTokens: 33_460, outputTokens: 3_104 });
  expect(summary.decodeTps).toBeCloseTo(3_104 / (1_000 / 25 + 604 / 40.3 + 1_500 / 50), 6);
  expect(summary.cacheFraction).toBeCloseTo(33_460 / 54_420, 6);
});

test('overlapping or early steps count once and only inside the window; a running turn uses now', () => {
  const overlapping = [inferred({ seq: 1, startedAt: T0 - 500, finishedAt: T0 + 10_000 }), inferred({ seq: 2, startedAt: T0 + 5_000, finishedAt: T0 + 12_000 })];
  expect(summarizeTurn(window, overlapping)).toMatchObject({ modelMs: 12_000, toolMs: 100_000 });
  expect(summarizeTurn({ ...window, endedAt: null, outcome: null }, overlapping)).toBeNull();
  expect(summarizeTurn({ ...window, endedAt: null, outcome: null }, overlapping, T0 + 20_000)).toMatchObject({ wallMs: 20_000, modelMs: 12_000 });
});

test('no summary unless every step is attributed, the start was seen and a total exists', () => {
  expect(summarizeTurn(window, [])).toBeNull();
  expect(summarizeTurn({ ...window, startedAt: null }, steps)).toBeNull();
  expect(summarizeTurn(window, [...steps, step({ seq: 4, finishedAt: T0 + 100_000 })])).toBeNull();
  expect(summarizeTurn(window, [...steps, step({ seq: 4, finishedAt: T0 + 100_000, verdict: { attr: 'withheld', reason: 'overlap', at: T0 } })])).toBeNull();
  const noOutput = { ...steps[0]!, outputTokens: undefined };
  expect(summarizeTurn(window, [noOutput, ...steps.slice(1)])).toBeNull();
});

test('values a step does not report stay unknown rather than partial', () => {
  const partial = [{ ...steps[0]!, promptTokens: undefined, decodeTps: undefined, ttftMs: undefined }, steps[1]!, { ...steps[2]!, startedAt: null }];
  const summary = summarizeTurn(window, partial)!;
  expect(summary).toMatchObject({ promptTokens: null, cacheFraction: null, decodeTps: null, modelMs: null, toolMs: null, firstTtftMs: 520 });
  expect(summarizeTurn(window, [inferred({ seq: 9, startedAt: T0 + 1_000, finishedAt: T0 + 2_000, ttftMs: undefined })])!.firstTtftMs).toBeNull();
  expect(summarizeTurn(window, [inferred({ seq: 9, startedAt: T0 + 1_000, finishedAt: T0 + 2_000, outputTokens: 0, decodeTps: undefined })]))
    .toMatchObject({ outputTokens: 0, decodeTps: null });
});
