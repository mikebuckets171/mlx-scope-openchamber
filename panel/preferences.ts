import type { HostClient } from '@openchamber/sdk';
import { PrefStore, type PrefPatch } from './history/prefs.ts';

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

/**
 * `pref.v2` (plan §5.6) for the shell: the ledger's PrefStore (one schema, parsed field by field, one write per real
 * change) with this frame's choices applied at once, so a click re-renders before the write lands.
 */
export interface PrefV2 {
  statusExpanded?: boolean;                  // Work Status shows Turn stats instead of the glance
  tipDismissed?: boolean;                    // "Replace Turn stats" tip
  firstRunDismissed?: boolean;               // "Recording reply history locally" (stored as noticeDismissed)
  toasts?: 'critical' | 'all' | 'off';       // alerts.toasts (default critical)
  autoLabel?: boolean;                       // attribution.auto (default on)
  retentionDays?: number;                    // ledger retention, 1–90 days (default 30)
  history?: boolean;                         // false: recording paused
}
export class PrefsV2 {
  private readonly store: PrefStore;
  private overlay: PrefPatch = {};
  constructor(storage: HostClient['storage']) { this.store = new PrefStore(storage); }
  get value(): PrefV2 {
    const v = { ...this.store.value, ...this.overlay };
    return { statusExpanded: v.statusExpanded, tipDismissed: v.tipDismissed, firstRunDismissed: v.noticeDismissed, toasts: v.toasts,
      autoLabel: v.autoLabel, retentionDays: v.retentionDays, history: v.history };
  }
  async load(): Promise<PrefV2> { await this.store.load(); return this.value; }
  set(patch: PrefV2): Promise<void> {
    const { firstRunDismissed, ...rest } = patch, next: PrefPatch = { ...rest, ...firstRunDismissed !== undefined ? { noticeDismissed: firstRunDismissed } : {} };
    this.overlay = { ...this.overlay, ...next };
    return this.store.update(next).then(() => undefined);
  }
}
