import type { CompletionV2 } from '../../src/contract/completion.ts';
import { frameReading, linkIdentity, type HostReading, type Reading } from '../present/reading.ts';
import { ResourceHistory } from '../resources.ts';
import { SignalHistory } from '../signal.ts';
import type { Workspace } from '../workspace.ts';

type Completions = { instance: string; cursor: number; newest: CompletionV2 | null };

/** The panel's one mutable state. Presenters only read it; the monitor and main's handlers change it. */
export class ScopeState {
  latest: Reading;                           // the newest reading applied, available or not
  last: Reading | null = null;               // the newest available reading
  lastHost: HostReading | null = null;       // the newest host reading, kept while readings stop
  signal = new SignalHistory();
  resources = new ResourceHistory();
  failures = 0;
  surface = 'panel';
  userPaused = false; efficient = false; compact = false; view: Workspace = 'live';
  mounted = false; startupFailed = false; disposed = false;
  generation = 0;                            // bumped to discard a request already in flight
  manualRefresh = false; interrupted = false; awaitingFresh = false;
  freshnessTimer: ReturnType<typeof setTimeout> | null = null;
  statusTimer: ReturnType<typeof setTimeout> | null = null;
  private monitored: string | null = null;
  private completions: Completions | null = null;
  constructor(now: number) { this.latest = frameReading('runtime_unreachable', null, now); }

  /** True when the reading is from another connection than the observations so far, which must be cleared first. */
  isNewConnection(reading: Reading): boolean {
    return reading.link !== null && this.monitored !== null && linkIdentity(reading.link) !== this.monitored;
  }
  accept(reading: Reading): void {
    if (reading.link) this.monitored = linkIdentity(reading.link);
    this.latest = reading;
    if (reading.available) this.last = reading;
    if (reading.host) this.lastHost = reading.host;
    const completions = reading.body?.completions;
    if (!completions) return;
    // With `since`, a poll carries only newer completions; keep the newest until the ring restarts or rolls back.
    const kept = this.completions, same = kept?.instance === completions.instance && !completions.reset && completions.cursor >= kept.cursor;
    this.completions = { instance: completions.instance, cursor: completions.cursor, newest: completions.items.at(-1) ?? (same ? kept!.newest : null) };
  }
  /** The newest finished request the service reported, shown only beside an available reading. */
  get lastRequest(): CompletionV2 | null { return this.latest.available ? this.completions?.newest ?? null : null; }
  /** The completion cursor for the next poll's `since`. */
  get since(): number | undefined { return this.completions?.cursor; }
  clearObservations(): void {
    this.last = null; this.lastHost = null; this.monitored = null; this.completions = null;
    this.signal = new SignalHistory(); this.resources = new ResourceHistory();
  }
}
