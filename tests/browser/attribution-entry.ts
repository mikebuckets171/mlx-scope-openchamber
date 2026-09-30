// Browser check for panel/attribution, bundled by attribution.spec.ts at test time and never shipped: the tag hash and
// the whole frame-side flow (the real SDK's session replays, the auto rule, the wire queue) run the same in Chromium
// and WebKit, with `crypto.subtle` removed as a guest frame may have it.
import type { SessionSnapshot } from '@openchamber/sdk';
import { tag8 } from '../../src/contract/hash.ts';
import { Attribution } from '../../panel/attribution/controller.ts';
import { body, CHAT, fakeHost, step, T0 } from '../../panel/attribution/testing.ts';

const run = () => {
  Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });
  const tags = ['ses_fixture0001', 'ses_fixture_chat_a', 'é', 'é', '😀🏳️‍🌈'].map(id => tag8(id, '5c1e0a7b'));
  const fake = fakeHost(), sent: string[] = [];
  let now = T0;
  fake.ready(CHAT);
  const attribution = new Attribution({ host: fake.host, now: () => now });
  const poll = (ms: number, active = 0, items = [] as ReturnType<typeof step>[]) => {
    now = T0 + ms;
    sent.push(new URLSearchParams(attribution.query()).toString());
    attribution.acknowledge();
    attribution.observe(body({ at: now, active, items }));
  };
  const chat = (ms: number, busy: boolean) => { now = T0 + ms; fake.transition({ ...CHAT, busy } as SessionSnapshot); };
  for (let ms = 0; ms < 2_000; ms += 500) poll(ms);
  chat(100, false); chat(200, false);
  chat(2_000, true);
  for (let ms = 2_000; ms < 6_000; ms += 500) poll(ms, 1);
  poll(6_000, 0, [step({ seq: 1, startedAt: T0 + 2_200, finishedAt: T0 + 5_900, model: 'mlx-community/Qwen3.8-27B-4bit' })]);
  chat(6_300, false);
  for (let ms = 6_500; ms < 9_000; ms += 500) poll(ms);
  return { tags, subtle: typeof globalThis.crypto.subtle, sent: sent.filter(Boolean), state: JSON.stringify(attribution.frame()),
    label: attribution.label({ seq: 1 }), turn: attribution.turn()?.summary?.steps ?? null };
};

(globalThis as unknown as { ScopeAttribution: unknown }).ScopeAttribution = { run };
