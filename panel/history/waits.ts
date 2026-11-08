import type { RuntimeKind } from '../../src/contract/runtime.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import { modelOf } from '../present/scope.ts';
import type { WaitKind } from './ledger-schema.ts';

// Owner: ledger. 5.5: engine waits for History, seen by the leading frame from each poll's `admission` (contract
// `server.admission`). Engine-wide, never per chat: a wait while another chat runs is exactly the case to keep.

/** Waits shorter than one poll are noise next to the seconds a second chat can wait; they are not kept. */
export const MIN_WAIT_MS = 1_000;
/** The oldest wait dropping this far below the one being followed means that request started and a newer one waits. */
const NEWER_WAITER_MS = 1_500;

export interface EngineWait { kind: WaitKind; startedAt: number; waitMs: number; rt: RuntimeKind; model: string | null }

/**
 * One wait from the first reading that showed it until a reading where nothing waits. Its start comes from the engine's
 * own oldest-wait clock, so a frame that starts leading mid-wait still dates it right; its length is the longest wait
 * observed, short of the truth by at most one poll.
 */
export class WaitWatch {
  #open: (EngineWait & { connection: string }) | null = null;

  /** One snapshot; returns the wait that just ended, if it is long enough to keep. */
  observe(snapshot: SnapshotV2): EngineWait | null {
    const gate = snapshot.status.state === 'ready' ? snapshot.runtime.server.admission : undefined, rt = snapshot.connection.runtime;
    const connection = snapshot.connection.id, at = snapshot.runtime.sampledAt ?? snapshot.serverNow;
    // Another connection makes a followed wait unknowable; a reading that says nothing about waits ends nothing.
    if (this.#open && this.#open.connection !== connection) this.#open = null;
    if (!gate || !rt) return null;
    const kind: WaitKind | null = gate.waitingMemory > 0 ? 'memory' : gate.waitingConcurrency > 0 ? 'concurrency' : null;
    const waited = gate.oldestWaitMs ?? 0, open = this.#open;
    if (!kind) { this.#open = null; return open ? this.#kept(open) : null; }
    if (open && waited >= open.waitMs - NEWER_WAITER_MS) {
      open.waitMs = Math.max(open.waitMs, waited);
      if (kind === 'memory') open.kind = 'memory';
      return null;
    }
    // The first sight of a wait, or a newer request now the oldest waiter: the one followed so far has ended.
    this.#open = { kind, startedAt: at - waited, waitMs: waited, rt, model: modelOf(snapshot), connection };
    return open ? this.#kept(open) : null;
  }

  reset(): void { this.#open = null; }

  #kept(wait: EngineWait & { connection: string }): EngineWait | null {
    const { connection: _connection, ...kept } = wait;
    return kept.waitMs >= MIN_WAIT_MS ? kept : null;
  }
}
