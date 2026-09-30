export type PreferenceKey = 'compact' | 'efficient';
type Storage = { get(key: string): Promise<unknown>; set(key: string, value: boolean): Promise<void> };

/** Two tiny SDK values. Read once; write only on clicks. No subscriptions or polling. */
export class Preferences {
  private revisions = { compact: 0, efficient: 0 };
  private writes: Record<PreferenceKey, Promise<void>> = { compact: Promise.resolve(), efficient: Promise.resolve() };
  constructor(private readonly storage: Storage) {}
  async load(apply: (key: PreferenceKey, value: boolean) => void): Promise<void> {
    await Promise.all((['compact', 'efficient'] as const).map(async key => {
      const revision = this.revisions[key];
      try {
        const value = await this.storage.get(`view.${key}`);
        if (typeof value === 'boolean' && revision === this.revisions[key]) apply(key, value);
      } catch { /* A missing/unsupported store must never block monitoring. */ }
    }));
  }
  set(key: PreferenceKey, value: boolean): Promise<void> {
    this.revisions[key] += 1;
    const next = this.writes[key].catch(() => {}).then(() => this.storage.set(`view.${key}`, value));
    this.writes[key] = next;
    return next;
  }
}

/** `pref.v2` (plan §5.6): one small object, read once, written only on a click. Keys other tracks add are kept. */
export interface PrefV2 {
  statusExpanded?: boolean;                  // Work Status shows Turn stats instead of the glance
  tipDismissed?: boolean;                    // "Replace Turn stats" tip
  firstRunDismissed?: boolean;               // "Recording reply history locally"
  toasts?: 'critical' | 'all' | 'off';       // alerts.toasts (default critical)
  autoLabel?: boolean;                       // attribution.auto (default on)
}
type Stored = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<void> };
const PREF_KEY = 'pref.v2';
const TOASTS = ['critical', 'all', 'off'] as const;
const clean = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export class PrefsV2 {
  private stored: Record<string, unknown> = {};
  private writes: Promise<void> = Promise.resolve();
  private revision = 0;
  constructor(private readonly storage: Stored) {}
  get value(): PrefV2 {
    const s = this.stored, bool = (key: string) => typeof s[key] === 'boolean' ? s[key] as boolean : undefined;
    return { statusExpanded: bool('statusExpanded'), tipDismissed: bool('tipDismissed'), firstRunDismissed: bool('firstRunDismissed'),
      toasts: TOASTS.find(item => item === s.toasts), autoLabel: bool('autoLabel') };
  }
  async load(): Promise<PrefV2> {
    const revision = this.revision;
    try { const value = clean(await this.storage.get(PREF_KEY)); if (revision === this.revision) this.stored = value; } catch { /* never blocks monitoring */ }
    return this.value;
  }
  /** Applies at once; the write re-reads the stored object first, so another frame's keys survive. */
  set(patch: PrefV2): Promise<void> {
    this.revision += 1;
    this.stored = { ...this.stored, ...patch };
    const next = this.writes.catch(() => {}).then(async () => {
      let current: Record<string, unknown> = {};
      try { current = clean(await this.storage.get(PREF_KEY)); } catch { /* write what this frame knows */ }
      await this.storage.set(PREF_KEY, { ...current, ...patch } as never);
    });
    this.writes = next;
    return next;
  }
}
