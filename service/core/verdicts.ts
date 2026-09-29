import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { SnapshotQuery } from '../../src/contract/query.ts';

/** One per completion the service ring can hold. */
export const VERDICT_LIMIT = 128;
export type VerdictV2 = NonNullable<CompletionV2['verdict']>;

/**
 * Attribution verdicts from visible frames (`attr=`), kept next to their completion seq so that whichever frame leads
 * later writes the same label. The first verdict stands; only an armed capture replaces it, because the frame that
 * armed Next reply checked every step itself.
 */
export class Verdicts {
  private readonly bySeq = new Map<number, VerdictV2>();

  /** `head` is the newest completion seq assigned; a verdict for a later seq names nothing and is dropped. */
  record(attrs: SnapshotQuery['attrs'], now: number, head: number): void {
    for (const { seq, attr, reason } of attrs) {
      const current = this.bySeq.get(seq);
      if (seq > head || current && (current.attr === 'armed' || attr !== 'armed')) continue;
      this.bySeq.set(seq, reason ? { attr, reason, at: now } : { attr, at: now });
      if (this.bySeq.size > VERDICT_LIMIT) this.bySeq.delete(Math.min(...this.bySeq.keys()));
    }
  }

  get(seq: number): VerdictV2 | undefined { return this.bySeq.get(seq); }
}
