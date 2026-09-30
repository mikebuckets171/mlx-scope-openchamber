import { expect, test } from 'bun:test';
import { MAX_ATTRS, MAX_MARKS, parseSnapshotQuery } from '../../src/contract/query.ts';
import { QUEUE_LIMIT, WireQueue } from './wire.ts';
import { T0 } from './testing.ts';

const marks = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) => ({ phase: 'started' as const, at: T0 + (from + index) * 1_000, tag: 'deadbeef' }));
const service = (query: { mark?: string; attr?: string }) => parseSnapshotQuery(new URLSearchParams(query));

test('the oldest pending items go first, up to each cap, and the service parses them', () => {
  const queue = new WireQueue();
  queue.mark(marks(6));
  queue.attr([{ seq: 58, attr: 'withheld', reason: 'outside-turn' }, { seq: 59, attr: 'inferred', reason: null }]);
  const query = queue.query();
  expect(query.mark!.split(',')).toHaveLength(MAX_MARKS);
  expect(query.mark!.startsWith(`started.${T0}.deadbeef`)).toBe(true);
  expect(query.attr).toBe('58.withheld.outside-turn,59.inferred.-');
  expect(service(query)).toMatchObject({ marks: marks(4), attrs: [{ seq: 58, attr: 'withheld', reason: 'outside-turn' }, { seq: 59, attr: 'inferred', reason: null }] });
  expect(new WireQueue().query()).toEqual({});
});

test('a 200 drops what was sent; a failed poll resends; items queued in between stay', () => {
  const queue = new WireQueue();
  queue.mark(marks(6));
  const first = queue.query();
  queue.mark(marks(1, 10));
  queue.query();                                              // a failed poll: no acknowledge
  expect(queue.query()).toEqual(first);
  queue.acknowledge();
  expect(queue.pending.marks).toBe(3);
  expect(queue.query().mark!.split(',').map(item => Number(item.split('.')[1]) - T0)).toEqual([4_000, 5_000, 10_000]);
  queue.acknowledge(); queue.acknowledge();
  expect(queue.query()).toEqual({});
});

test('one verdict per seq: newer replaces older, only armed replaces armed, in-flight ones are left alone', () => {
  const queue = new WireQueue();
  queue.attr([{ seq: 7, attr: 'inferred', reason: null }, { seq: 7, attr: 'armed', reason: null }, { seq: 7, attr: 'withheld', reason: 'overlap' }]);
  expect(queue.query().attr).toBe('7.armed.-');
  queue.attr([{ seq: 7, attr: 'armed', reason: null }]);         // sent but not acknowledged: queued again beside it
  expect(queue.pending.attrs).toBe(2);
  queue.acknowledge();
  expect(queue.query().attr).toBe('7.armed.-');
  queue.attr(Array.from({ length: 12 }, (_, index) => ({ seq: 100 + index, attr: 'inferred' as const, reason: null })));
  queue.acknowledge();
  expect(queue.query().attr!.split(',')).toHaveLength(MAX_ATTRS);
});

test('bounded while polls keep failing, and cleared for a new service instance', () => {
  const queue = new WireQueue();
  queue.mark(marks(QUEUE_LIMIT + 10));
  queue.attr(Array.from({ length: QUEUE_LIMIT + 10 }, (_, index) => ({ seq: index + 1, attr: 'inferred' as const, reason: null })));
  expect(queue.pending).toEqual({ marks: QUEUE_LIMIT, attrs: QUEUE_LIMIT });
  expect(queue.query().attr!.startsWith('11.inferred')).toBe(true);
  queue.clear();
  expect(queue.pending).toEqual({ marks: 0, attrs: 0 });
  queue.acknowledge();
  expect(queue.query()).toEqual({});
});
