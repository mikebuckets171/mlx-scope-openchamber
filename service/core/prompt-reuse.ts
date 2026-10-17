import type { PromptObservation } from './adapter-v2.ts';

// Per-chat prompt reuse, in memory only: the newest two prompts each chat's runtime reported, keyed by the hashed chat
// key the companion and the frame share. Nothing here is persisted, exported or used to label a reading.
export const PROMPT_REUSE_CHATS = 32;
export const PROMPT_REUSE_TTL_MS = 30 * 60_000;
export interface PromptCounts { total: number; cache: number; observedAt: number }
export interface PromptReuse { latest: PromptCounts; previous: PromptCounts | null }

export class PromptReuseStore {
  readonly #chats = new Map<string, Array<{ requestID: string } & PromptCounts>>();
  observe(prompts: readonly PromptObservation[] | undefined, now: number): void {
    for (const prompt of prompts ?? []) {
      const list = this.#chats.get(prompt.sessionKey) ?? [], entry = { requestID: prompt.requestID, total: prompt.total, cache: prompt.cache, observedAt: prompt.observedAt };
      const index = list.findIndex(item => item.requestID === prompt.requestID);
      if (index >= 0) list[index] = entry; else list.push(entry);
      // Most recent use first in the map; at most two prompts per chat.
      this.#chats.delete(prompt.sessionKey); this.#chats.set(prompt.sessionKey, list.slice(-2));
    }
    for (const [key, list] of this.#chats) {
      if (this.#chats.size <= PROMPT_REUSE_CHATS && list.at(-1)!.observedAt >= now - PROMPT_REUSE_TTL_MS) continue;
      this.#chats.delete(key);
    }
  }
  for(sessionKey: string | undefined): PromptReuse | null {
    const list = sessionKey ? this.#chats.get(sessionKey) : undefined, latest = list?.at(-1);
    if (!list || !latest) return null;
    const previous = list.length > 1 ? list.at(-2)! : null, counts = ({ total, cache, observedAt }: PromptCounts): PromptCounts => ({ total, cache, observedAt });
    return { latest: counts(latest), previous: previous ? counts(previous) : null };
  }
}
