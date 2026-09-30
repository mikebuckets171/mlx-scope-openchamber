// Test support only: a service completion ring as /v2/snapshot serves it (seq > since, ≤ 64 oldest first, `reset` when
// the cursor is foreign or fell off), and completions shaped like the contract's.
import type { CompletionsV2, CompletionV2 } from '../../src/contract/completion.ts';

export const INSTANCE = '5c1e0a7b';
export const T0 = 1_790_690_700_000;
export const completion = (seq: number, finishedAt: number, extra: Partial<CompletionV2> = {}): CompletionV2 => ({
  seq, finishedAt, startedAt: finishedAt - 20_000, model: 'Example-27B-4bit', basis: 'reported', promptTokens: 12_000 + seq % 7 * 1_000,
  cachedTokens: 8_000, outputTokens: 900 + seq % 11 * 37, ttftMs: 500 + seq % 5 * 10, decodeTps: 38 + seq % 3 * 0.4, prefillTps: 600 - seq % 4 * 3,
  overlapped: false, host: {}, ...extra,
});
export class FakeRing {
  items: CompletionV2[] = [];
  seq = 0;
  constructor(public instance = INSTANCE, private readonly capacity = 128) {}
  add(finishedAt: number, extra: Partial<CompletionV2> = {}): CompletionV2 {
    const item = completion(++this.seq, finishedAt, extra);
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
    return item;
  }
  verdict(seq: number, verdict: CompletionV2['verdict']): void { const item = this.items.find(entry => entry.seq === seq); if (item) item.verdict = verdict; }
  response(since?: number): CompletionsV2 {
    const cursor = this.seq, oldest = this.items[0]?.seq ?? cursor + 1;
    const reset = since !== undefined && (since > cursor || since < oldest - 1);
    const items = this.items.filter(item => since === undefined || reset || item.seq > since).slice(0, 64);
    return { instance: this.instance, cursor, reset, items: structuredClone(items) };
  }
}
