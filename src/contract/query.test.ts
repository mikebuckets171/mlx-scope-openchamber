import { expect, test } from 'bun:test';
import { isBadQuery, parseSnapshotQuery, parseTrendQuery, parseUsageQuery } from './query.ts';

const q = (text: string) => new URLSearchParams(text);

test('snapshot queries follow the contract grammar', () => {
  expect(parseSnapshotQuery(q(''))).toEqual({ tier: 'full', marks: [], attrs: [] });
  expect(parseSnapshotQuery(q('surface=status'))).toEqual({ surface: 'status', tier: 'glance', marks: [], attrs: [] });
  expect(parseSnapshotQuery(q('provider=local.omlx_2-a&runtime=llama-server&frame=0a1b2c3d&surface=page&tier=full&since=58&detail=server'
    + '&mark=started.1790690700000.deadbeef&mark=completed.1790690710000.deadbeef&attr=58.withheld.several-chats&attr=59.inferred.-&attr=60.armed.-&unknown=1')))
    .toEqual({ provider: 'local.omlx_2-a', runtime: 'llama-server', frame: '0a1b2c3d', surface: 'page', tier: 'full', since: 58, detail: 'server',
      marks: [{ phase: 'started', at: 1_790_690_700_000, tag: 'deadbeef' }, { phase: 'completed', at: 1_790_690_710_000, tag: 'deadbeef' }],
      attrs: [{ seq: 58, attr: 'withheld', reason: 'several-chats' }, { seq: 59, attr: 'inferred', reason: null }, { seq: 60, attr: 'armed', reason: null }] });
});

test.each([
  ['provider=my omlx', 'provider'], ['provider=', 'provider'], [`provider=${'x'.repeat(65)}`, 'provider'], ['runtime=mlx', 'runtime'],
  ['frame=0A1B2C3D', 'frame'], ['frame=0a1b2c3', 'frame'], ['surface=headless', 'surface'], ['tier=deep', 'tier'], ['since=-1', 'since'],
  ['since=1.5', 'since'], ['since=1&since=2', 'since'], ['detail=server', 'detail'], ['tier=glance&detail=server', 'detail'], ['detail=all&tier=full', 'detail'],
  ['mark=started.1.deadbee', 'mark'], ['mark=paused.1.deadbeef', 'mark'], ['mark=started.x.deadbeef', 'mark'], ['mark=started.1.deadbeef.extra', 'mark'],
  [Array.from({ length: 5 }, () => 'mark=started.1.deadbeef').join('&'), 'mark'], ['attr=58.withheld.-', 'attr'], ['attr=58.maybe.-', 'attr'],
  ['attr=0.inferred.-', 'attr'], ['attr=58.withheld.all-requests', 'attr'], [Array.from({ length: 9 }, (_, index) => `attr=${index + 1}.inferred.-`).join('&'), 'attr'],
])('snapshot %s is bad_query on %s, without echoing the value', (text, param) => {
  const result = parseSnapshotQuery(q(text));
  expect(result).toEqual({ error: 'bad_query', param });
  expect(isBadQuery(result)).toBe(true);
});

test('trend and usage queries', () => {
  expect(parseTrendQuery(q(''))).toEqual({ windowMs: 900_000, series: ['decodeTps'] });
  expect(parseTrendQuery(q('provider=omlx&window=3600&series=decodeTps,cpuFraction,decodeTps'))).toEqual({ provider: 'omlx', windowMs: 3_600_000, series: ['decodeTps', 'cpuFraction'] });
  for (const text of ['window=600', 'window=900&window=1800', 'series=gpuPercent', 'series=', 'series=decodeTps,', 'runtime=ollama2']) {
    expect(isBadQuery(parseTrendQuery(q(text))), text).toBe(true);
  }
  expect(parseUsageQuery(q('range=90d&provider=omlx'))).toEqual({ provider: 'omlx', range: '90d' });
  expect(parseUsageQuery(q(''))).toEqual({ range: '7d' });
  expect(parseUsageQuery(q('range=today'))).toEqual({ error: 'bad_query', param: 'range' });
});
