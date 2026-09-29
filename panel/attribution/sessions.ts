import type { HostClient } from '@openchamber/sdk';
import type { SnapshotQuery } from '../../src/contract/query.ts';

// Owner: attribution. The open chat as the frame sees it, from onSession + onSessionLifecycle only (S2: no `sessions`
// capability). Replays (×3 on mount and on switch) are ignored; repeats are deduped on (session, phase) changes; events
// are stamped on receipt in service time. Session ids and titles never leave this module: the tag is tag8(id, instance).

export const LIFECYCLE_HOLD_MS = 1_000;      // S2: started leads runtime busy by 0.14–0.20 s; completed within 0.5 s

/** A live-observed turn window. `startedAt: null` = joined mid-turn (the first event after mount or switch). */
export interface TurnWindow { tag: string; startedAt: number | null; endedAt: number | null; outcome: 'completed' | 'failure' | null }
export interface FrameSessionState {
  connected: boolean;
  /** The open chat; `model` is the SDK string, `provider` its provider id. No id, title or folder. */
  chat: { tag: string; provider: string | null; model: string | null; busy: boolean } | null;
  windows: readonly TurnWindow[];            // newest last, ≤ 16
}
export class SessionFeed {
  constructor(host: Pick<HostClient, 'onSession' | 'onSessionLifecycle'>, now: () => number, instance: () => string | null) {
    void host; void now; void instance;
  }
  state(): FrameSessionState { return { connected: false, chat: null, windows: [] }; }
  /** Marks observed live since the last drain, for `mark=` (never replays). */
  drainMarks(): SnapshotQuery['marks'] { return []; }
  onChange(listener: () => void): () => void { void listener; return () => {}; }
  dispose(): void {}
}
