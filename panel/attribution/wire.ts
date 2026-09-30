import { encodeAttrs, encodeMarks, MAX_ATTRS, MAX_MARKS, type SnapshotQuery } from '../../src/contract/query.ts';

// Owner: attribution. Pending `mark=` / `attr=` items for the next poll, kept until a 200 acknowledges them. The service
// dedupes marks (tag, phase, ±1 s) and keeps the first verdict per seq, so a resend after a failed poll is harmless.

type MarkItem = SnapshotQuery['marks'][number];
type AttrItem = SnapshotQuery['attrs'][number];
/** Oldest dropped beyond this: a frame whose polls keep failing does not grow without bound. */
export const QUEUE_LIMIT = 32;

export class WireQueue {
  private marks: MarkItem[] = [];
  private attrs: AttrItem[] = [];
  private sent: { marks: Set<MarkItem>; attrs: Set<AttrItem> } | null = null;

  mark(items: SnapshotQuery['marks']): void {
    if (items.length) this.marks = [...this.marks, ...items].slice(-QUEUE_LIMIT);
  }

  /** One pending verdict per seq: a newer one replaces it, except that nothing but `armed` replaces `armed`. */
  attr(items: SnapshotQuery['attrs']): void {
    for (const item of items) {
      const index = this.attrs.findIndex(pending => pending.seq === item.seq && !this.sent?.attrs.has(pending));
      if (index < 0) this.attrs.push(item);
      else if (item.attr === 'armed' || this.attrs[index]!.attr !== 'armed') this.attrs[index] = item;
    }
    this.attrs = this.attrs.slice(-QUEUE_LIMIT);
  }

  /** The encoded values for panel/data/client.ts SnapshotQuery `mark` / `attr`: the oldest pending, up to each cap. */
  query(): { mark?: string; attr?: string } {
    const marks = this.marks.slice(0, MAX_MARKS), attrs = this.attrs.slice(0, MAX_ATTRS);
    this.sent = { marks: new Set(marks), attrs: new Set(attrs) };
    const mark = encodeMarks(marks), attr = encodeAttrs(attrs);
    return { ...mark ? { mark } : {}, ...attr ? { attr } : {} };
  }

  /** After a 200: drop what the last `query()` sent. Items queued since stay. */
  acknowledge(): void {
    const sent = this.sent;
    if (!sent) return;
    this.marks = this.marks.filter(item => !sent.marks.has(item));
    this.attrs = this.attrs.filter(item => !sent.attrs.has(item));
    this.sent = null;
  }

  /** A new service instance: its seqs and tags name nothing the old one knew. */
  clear(): void { this.marks = []; this.attrs = []; this.sent = null; }

  get pending(): { marks: number; attrs: number } { return { marks: this.marks.length, attrs: this.attrs.length }; }
}
