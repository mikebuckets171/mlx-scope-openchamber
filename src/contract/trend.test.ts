import { expect, test } from 'bun:test';
import fixtures from '../../docs/design/2.0-mock-fixtures.json';
import { parseTrendV2 } from './trend.ts';

type Body = Record<string, any>;
const base = (): Body => structuredClone(fixtures.trend) as Body;
const edit = (change: (body: Body) => void): Body => { const body = base(); change(body); return body; };

test('the G2 mock trends parse unchanged', () => {
  for (const trend of [fixtures.trend, fixtures.trendFresh]) expect(parseTrendV2(structuredClone(trend))).toEqual(structuredClone(trend) as never);
});

test.each([
  ['null', null], ['contract v1', edit(body => { body.contractVersion = 1; })], ['a 10 min window', edit(body => { body.windowMs = 600_000; body.bucketMs = 600_000 / 180; })],
  ['a bucket size that is not window / 180', edit(body => { body.bucketMs = 10_000; })], ['no series', edit(body => { delete body.series; })],
  ['gaps not a list', edit(body => { body.gaps = {}; })], ['no startAt', edit(body => { delete body.startAt; })],
  ['a tag on a mark', edit(body => { body.marks[0].tag = 'deadbeef'; })], ['a session id', edit(body => { body.sessionId = 'x'; })],
] as Array<[string, unknown]>)('rejects %s', (_, body) => { expect(parseTrendV2(body)).toBeNull(); });

test('buckets hold readings or null, never placeholders', () => {
  const parsed = parseTrendV2(edit(body => {
    body.series = {
      decodeTps: { basis: 'reported', buckets: [[1, 3, 2], [2, 1, 1], [1, 2, 3], null, [1, 2], ['1', 2, 2], [-1, 2, 1]] },
      cpuFraction: { basis: 'reported', buckets: [[0.1, 0.9, 0.5], [0.1, 1.5, 0.5]] },
      pressureLevel: { basis: 'reported', buckets: [[1, 4, 2], [1, 3, 2]] },
      memUsedBytes: { basis: 'reported', buckets: [[1, 3, 2], [1.5, 3, 2]] },
      chipW: { basis: 'guessed', buckets: [[1, 2, 1]] }, gpuPercent: { basis: 'reported', buckets: [] },
      active: { basis: 'observed', buckets: Array.from({ length: 181 }, () => [0, 1, 1]) },
    };
    body.gaps = [{ fromAt: 5, toAt: 4 }, { fromAt: 4, toAt: 5 }];
    body.marks = [{ seq: 1, at: 2, phase: 'started' }, { seq: 2, at: 3, phase: 'paused' }];
  }))!;
  expect(parsed.series).toEqual({
    decodeTps: { basis: 'reported', buckets: [[1, 3, 2], null, null, null, null, null, null] },
    cpuFraction: { basis: 'reported', buckets: [[0.1, 0.9, 0.5], null] },
    pressureLevel: { basis: 'reported', buckets: [[1, 4, 2], null] },
    memUsedBytes: { basis: 'reported', buckets: [[1, 3, 2], null] },
  });
  expect(parsed.gaps).toEqual([{ fromAt: 4, toAt: 5 }]);
  expect(parsed.marks).toEqual([{ seq: 1, at: 2, phase: 'started' }]);
});
