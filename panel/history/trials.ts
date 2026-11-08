import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import type { Ledger } from './ledger.ts';
import { batchRow, trialChangeRow, type BatchRow, type TrialChangeRow } from './ledger-schema.ts';

// Owner: ledger. 5.5 trial boundaries and bounded decode-batch deltas. No inference, model load or exported data.

export const TRIAL_BATCH_INTERVAL_MS = 10 * 60_000;
const TRIAL_BATCH_MAX_GAP_MS = 2 * TRIAL_BATCH_INTERVAL_MS;

export interface TrialConfig {
  model: string;
  expertCapBytes: number | null;
  limitBytes: number | null;
  contextWindowTokens: number | null;
}

const nonnegative = (value: number | null | undefined): number | null => value != null && Number.isSafeInteger(value) && value >= 0 ? value : null;
const positive = (value: number | null | undefined): number | null => value != null && Number.isSafeInteger(value) && value > 0 ? value : null;

/** Splash's loaded model and plan, from its existing /status read only. */
export const trialConfigOf = (snapshot: SnapshotV2 | null): TrialConfig | null => {
  if (!snapshot || snapshot.connection.runtime !== 'splash' || snapshot.status.state !== 'ready') return null;
  const catalog = snapshot.runtime.catalog.find(item => item.format === 'splash' && item.loaded !== false);
  const residency = snapshot.runtime.residency.find(item => item.source === 'runtime');
  const model = snapshot.runtime.request?.model ?? catalog?.name ?? residency?.model;
  if (!model) return null;
  const room = snapshot.capabilities['server.memory.room'] ? snapshot.runtime.memory.room : undefined;
  const expertCapBytes = nonnegative(room?.accounts?.find(account => account.name === 'experts')?.capBytes);
  const limitBytes = positive(room?.limitBytes);
  const contextWindowTokens = positive(catalog?.contextWindowTokens ?? snapshot.runtime.request?.contextWindowTokens ?? residency?.contextWindowTokens);
  return { model, expertCapBytes, limitBytes, contextWindowTokens };
};

const sameConfig = (a: TrialConfig, b: TrialConfig): boolean => a.model === b.model && a.expertCapBytes === b.expertCapBytes
  && a.limitBytes === b.limitBytes && a.contextWindowTokens === b.contextWindowTokens;
const completeMissing = (current: TrialConfig, previous: TrialConfig): TrialConfig => current.model !== previous.model ? current : {
  model: current.model,
  expertCapBytes: current.expertCapBytes ?? previous.expertCapBytes,
  limitBytes: current.limitBytes ?? previous.limitBytes,
  contextWindowTokens: current.contextWindowTokens ?? previous.contextWindowTokens,
};
const configFromRow = (row: TrialChangeRow, models: readonly string[]): TrialConfig => ({ model: row[5] === null ? '' : models[row[5]] ?? '',
  expertCapBytes: row[2], limitBytes: row[3], contextWindowTokens: row[4] });
const keyOf = (snapshot: SnapshotV2): string => `${snapshot.service.instance}|${snapshot.connection.id}|${snapshot.connection.generation}`;
const batchesOf = (snapshot: SnapshotV2): { single: number; multi: number } | null => {
  if (snapshot.connection.runtime !== 'splash' || snapshot.status.state !== 'ready' || !snapshot.capabilities['server.batches']) return null;
  return snapshot.runtime.server.batches ?? null;
};

interface BatchAnchor { key: string; at: number; single: number; multi: number }

/** Serializes the first read, automatic changes and explicit starts from concurrent poll/click callbacks. */
export class TrialWatch {
  #queue: Promise<unknown> = Promise.resolve();
  #generation = 0;
  #loaded = false;
  #config: TrialConfig | null = null;
  #hasBoundary = false;
  #batch: BatchAnchor | null = null;

  observe(snapshot: SnapshotV2, ledger: Ledger, now: number): Promise<void> {
    const generation = this.#generation;
    return this.#enqueue(() => generation === this.#generation ? this.#observe(snapshot, ledger, now, generation) : Promise.resolve());
  }

  start(snapshot: SnapshotV2 | null, ledger: Ledger, now: number): Promise<boolean> {
    const generation = this.#generation;
    return this.#enqueue(async () => {
      if (generation !== this.#generation) return false;
      if (!snapshot || ledger.state === 'stopped' || ledger.state === 'paused') return false;
      await this.#observe(snapshot, ledger, now, generation);
      if (generation !== this.#generation) return false;
      const config = trialConfigOf(snapshot);
      if (!config) return false;
      const sampledAt = snapshot.runtime.sampledAt ?? snapshot.serverNow;
      this.#captureBatch(snapshot, ledger, sampledAt, true);
      this.#config = config;
      this.#hasBoundary = true;
      ledger.appendTrialChange(this.#row(config, true, now, ledger));
      this.#anchorBatch(snapshot, sampledAt);
      return true;
    });
  }

  reset(): void {
    this.#generation += 1;
    this.#loaded = false; this.#config = null; this.#hasBoundary = false; this.#batch = null;
  }

  #enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.catch(() => undefined).then(run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #load(ledger: Ledger, generation: number): Promise<void> {
    if (this.#loaded) return;
    const [side, models] = await Promise.all([ledger.readSide(), ledger.models()]);
    if (generation !== this.#generation) return;
    const latest = side.filter((row): row is TrialChangeRow => row[0] === 'c').at(-1);
    if (latest) { this.#config = configFromRow(latest, models); this.#hasBoundary = true; }
    this.#loaded = true;
  }

  async #observe(snapshot: SnapshotV2, ledger: Ledger, now: number, generation: number): Promise<void> {
    await this.#load(ledger, generation);
    if (generation !== this.#generation) return;
    const config = trialConfigOf(snapshot);
    if (!config) { this.#batch = null; return; }
    // Pause means no History facts are being kept. Preserve the last observed boundary so a later change is detected.
    if (ledger.state === 'paused' || ledger.state === 'stopped') { this.#batch = null; return; }
    const at = snapshot.runtime.sampledAt ?? snapshot.serverNow;
    const prior = this.#config;
    const comparable = prior ? completeMissing(config, prior) : config;
    if (!this.#hasBoundary) {
      this.#config = comparable; this.#hasBoundary = true;
      ledger.appendTrialChange(this.#row(comparable, false, at, ledger));
      this.#anchorBatch(snapshot, at);
      return;
    }
    if (prior && !sameConfig(comparable, prior)) {
      this.#captureBatch(snapshot, ledger, at, true);
      this.#config = comparable;
      ledger.appendTrialChange(this.#row(comparable, false, at, ledger));
      this.#anchorBatch(snapshot, at);
      return;
    }
    this.#config = comparable;
    this.#sampleBatch(snapshot, ledger, at, now);
  }

  #row(config: TrialConfig, manual: boolean, at: number, ledger: Ledger): TrialChangeRow {
    return trialChangeRow(at, config.expertCapBytes, config.limitBytes, config.contextWindowTokens, ledger.modelRef(config.model), manual);
  }

  #anchorBatch(snapshot: SnapshotV2, at: number): void {
    const counts = batchesOf(snapshot);
    this.#batch = counts ? { key: keyOf(snapshot), at, ...counts } : null;
  }

  #sampleBatch(snapshot: SnapshotV2, ledger: Ledger, at: number, _now: number): void {
    const counts = batchesOf(snapshot);
    if (!counts) { this.#batch = null; return; }
    const previous = this.#batch, key = keyOf(snapshot);
    if (!previous || previous.key !== key || counts.single < previous.single || counts.multi < previous.multi || at <= previous.at
      || at - previous.at > TRIAL_BATCH_MAX_GAP_MS) {
      this.#batch = { key, at, ...counts }; return;
    }
    if (at - previous.at >= TRIAL_BATCH_INTERVAL_MS) this.#appendBatch(ledger, at, counts, previous);
  }

  #captureBatch(snapshot: SnapshotV2, ledger: Ledger, at: number, force: boolean): void {
    const counts = batchesOf(snapshot), previous = this.#batch, key = keyOf(snapshot);
    if (!counts) { this.#batch = null; return; }
    if (!previous || previous.key !== key || counts.single < previous.single || counts.multi < previous.multi || at <= previous.at
      || at - previous.at > TRIAL_BATCH_MAX_GAP_MS) { this.#batch = { key, at, ...counts }; return; }
    if (force) this.#appendBatch(ledger, at, counts, previous);
  }

  #appendBatch(ledger: Ledger, at: number, counts: { single: number; multi: number }, previous: BatchAnchor): void {
    const single = counts.single - previous.single, multi = counts.multi - previous.multi;
    if (single + multi > 0) {
      const row: BatchRow = batchRow(at, single, multi);
      ledger.appendBatch(row);
    }
    this.#batch = { ...previous, at, ...counts };
  }
}
