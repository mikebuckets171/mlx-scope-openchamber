import type { HostClient, JsonValue } from '../host/types.ts';
import { assertHistoryVersion, DEFAULT_PREF, KEYS, parsePref, type PrefV2 } from './ledger-schema.ts';

// Owner: ledger. `pref.v2`, one small value for every surface. Read once per mount; written only on a user choice and
// only when a field changes; writes are serialized, and each re-reads the stored value so two frames' choices merge.

export type PrefPatch = Partial<Omit<PrefV2, 'v'>>;
export class PrefStore {
  #current: PrefV2 = { ...DEFAULT_PREF };
  #queue: Promise<unknown> = Promise.resolve();
  readonly #storage: HostClient['storage'];
  constructor(storage: HostClient['storage']) { this.#storage = storage; }
  get value(): Readonly<PrefV2> { return this.#current; }
  /** Never throws: a missing or unreadable store keeps the defaults, and monitoring goes on. */
  async load(): Promise<PrefV2> {
    try { const value = await this.#storage.get(KEYS.pref); assertHistoryVersion(value); this.#current = parsePref(value); } catch { /* defaults stay */ }
    return this.#current;
  }
  update(patch: PrefPatch): Promise<PrefV2> {
    const next = this.#queue.catch(() => undefined).then(async () => {
      const raw = await this.#storage.get(KEYS.pref);
      assertHistoryVersion(raw);
      const stored = parsePref(raw), merged = parsePref({ ...stored, ...patch });
      // Preserve additive fields from a compatible newer writer when changing one of our own preferences.
      if (JSON.stringify(merged) !== JSON.stringify(stored)) await this.#storage.set(KEYS.pref,
        { ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}), ...merged } as unknown as JsonValue);
      this.#current = merged;
      return merged;
    });
    this.#queue = next;
    return next;
  }
}
