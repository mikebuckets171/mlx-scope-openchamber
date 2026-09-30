import type { HostClient, JsonValue } from '@openchamber/sdk';
import { DEFAULT_PREF, KEYS, parsePref, type PrefV2 } from './ledger-schema.ts';

// Owner: ledger. `pref.v2`, one small value for every surface. Read once per mount; written only on a user choice and
// only when a field changes; writes are serialized, and each re-reads the stored value so two frames' choices merge.

export type PrefPatch = Partial<Omit<PrefV2, 'v'>>;
export class PrefStore {
  private current: PrefV2 = { ...DEFAULT_PREF };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: HostClient['storage']) {}
  get value(): Readonly<PrefV2> { return this.current; }
  /** Never throws: a missing or unreadable store keeps the defaults, and monitoring goes on. */
  async load(): Promise<PrefV2> {
    try { this.current = parsePref(await this.storage.get(KEYS.pref)); } catch { /* defaults stay */ }
    return this.current;
  }
  update(patch: PrefPatch): Promise<PrefV2> {
    const next = this.queue.catch(() => undefined).then(async () => {
      const stored = parsePref(await this.storage.get(KEYS.pref)), merged = parsePref({ ...stored, ...patch });
      if (JSON.stringify(merged) !== JSON.stringify(stored)) await this.storage.set(KEYS.pref, merged as unknown as JsonValue);
      this.current = merged;
      return merged;
    });
    this.queue = next;
    return next;
  }
}
