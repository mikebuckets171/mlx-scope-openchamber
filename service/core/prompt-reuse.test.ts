import { expect, test } from 'bun:test';
import { parsePromptCache } from '../../src/contract/snapshot.ts';
import { PROMPT_REUSE_CHATS, PROMPT_REUSE_TTL_MS, PromptReuseStore } from './prompt-reuse.ts';

const T = 1_790_690_700_000, A = 'a'.repeat(64), B = 'b'.repeat(64);
const prompt = (sessionKey: string, request: number, total: number, cache: number, observedAt: number) =>
  ({ sessionKey, requestID: `00000000-0000-4000-8000-${String(request).padStart(12, '0')}`, total, cache, observedAt });

test('each chat keeps its newest two prompts; a repeated observation updates its own request', () => {
  const store = new PromptReuseStore();
  store.observe([prompt(A, 1, 30_000, 27_000, T)], T);
  store.observe([prompt(A, 1, 30_000, 27_000, T + 500)], T + 500);
  expect(store.for(A)).toEqual({ latest: { total: 30_000, cache: 27_000, observedAt: T + 500 }, previous: null });
  store.observe([prompt(A, 2, 31_000, 0, T + 9_000)], T + 9_000);
  store.observe([prompt(A, 3, 32_000, 31_000, T + 20_000)], T + 20_000);
  expect(store.for(A)).toEqual({ latest: { total: 32_000, cache: 31_000, observedAt: T + 20_000 }, previous: { total: 31_000, cache: 0, observedAt: T + 9_000 } });
  expect(store.for(B)).toBeNull(); expect(store.for(undefined)).toBeNull();
});

test('chats expire after thirty minutes and the store stays bounded', () => {
  const store = new PromptReuseStore();
  store.observe([prompt(A, 1, 10, 0, T)], T);
  store.observe([], T + PROMPT_REUSE_TTL_MS + 1);
  expect(store.for(A)).toBeNull();
  for (let index = 0; index < PROMPT_REUSE_CHATS + 5; index += 1) store.observe([prompt(index.toString(16).padStart(64, '0'), 1, 10, 0, T)], T);
  expect(store.for('0'.repeat(64))).toBeNull();
  expect(store.for((PROMPT_REUSE_CHATS + 4).toString(16).padStart(64, '0'))).not.toBeNull();
});

test('the wire form is reported counts only, validated as a whole', () => {
  const latest = { total: 30_000, cache: 1_000, observedAt: T }, previous = { total: 29_000, cache: 27_000, observedAt: T - 60_000 };
  expect(parsePromptCache({ basis: 'reported', latest, previous }, T)).toEqual({ basis: 'reported', latest, previous });
  expect(parsePromptCache({ basis: 'reported', latest, previous: null }, T)).toEqual({ basis: 'reported', latest, previous: null });
  for (const bad of [{ basis: 'estimate', latest }, { basis: 'reported', latest: { ...latest, cache: 40_000 } }, { basis: 'reported', latest: { ...latest, observedAt: T + 1 } },
    { basis: 'reported', latest, previous: { ...previous, observedAt: T + 1 } }, { basis: 'reported', latest: { ...latest, total: 0 } }])
    expect(parsePromptCache(bad, T)).toBeUndefined();
});
