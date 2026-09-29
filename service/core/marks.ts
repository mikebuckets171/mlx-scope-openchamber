import type { SnapshotQuery } from '../../src/contract/query.ts';
import type { MarkPhase } from '../../src/contract/trend.ts';

export const MARK_RING = 64;
export const MARK_DEDUPE_MS = 1_000;
/** Marks outside the trend's 60 min window, or from a clock running ahead, are not stored. */
export const MARK_PAST_MS = 3_600_000;
export const MARK_FUTURE_MS = 60_000;
export interface TurnMark { seq: number; at: number; phase: MarkPhase }

/**
 * Turn markers from frames (`mark=`), in memory only. Several frames report the same lifecycle event, so a mark with
 * the same tag and phase within 1 s of a stored one is the same mark. The session tag never leaves this ring.
 */
export class Marks {
  private readonly ring: Array<TurnMark & { tag: string }> = [];
  private seq = 0;

  /** The newest mark's seq; 0 before the first. */
  get head(): number { return this.seq; }

  record(marks: SnapshotQuery['marks'], now: number): void {
    for (const { phase, at, tag } of marks) {
      if (at > now + MARK_FUTURE_MS || at < now - MARK_PAST_MS) continue;
      if (this.ring.some(item => item.tag === tag && item.phase === phase && Math.abs(item.at - at) <= MARK_DEDUPE_MS)) continue;
      this.ring.push({ seq: ++this.seq, at, phase, tag });
      if (this.ring.length > MARK_RING) this.ring.shift();
    }
  }

  /** Oldest first, without tags: the shape `/v2/trend` sends. */
  entries(): TurnMark[] { return this.ring.map(({ seq, at, phase }) => ({ seq, at, phase })); }
}
