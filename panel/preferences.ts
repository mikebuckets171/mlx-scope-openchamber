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
