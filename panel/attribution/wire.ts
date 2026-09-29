import { encodeAttrs, encodeMarks, type SnapshotQuery } from '../../src/contract/query.ts';

// Owner: attribution. Pending `mark=` / `attr=` items for the next poll, kept until a 200 acknowledges them. The service
// dedupes marks (tag, phase, ±1 s) and keeps the first verdict per seq, so a resend after a failed poll is harmless.

export class WireQueue {
  private marks: SnapshotQuery['marks'] = [];
  private attrs: SnapshotQuery['attrs'] = [];
  mark(items: SnapshotQuery['marks']): void { this.marks = [...this.marks, ...items]; }
  attr(items: SnapshotQuery['attrs']): void { this.attrs = [...this.attrs, ...items]; }
  /** The encoded values for panel/data/client.ts SnapshotQuery `mark` / `attr`. */
  query(): { mark?: string; attr?: string } {
    const mark = encodeMarks(this.marks), attr = encodeAttrs(this.attrs);
    return { ...mark ? { mark } : {}, ...attr ? { attr } : {} };
  }
  /** After a 200: drop what `query()` sent. */
  acknowledge(): void { throw new Error('WireQueue.acknowledge: not implemented (attribution)'); }
}
