import { expect, test } from 'bun:test';
import { encodeAttrs, encodeMarks, isBadQuery, MAX_ATTRS, MAX_MARKS, parseSnapshotQuery, parseTrendQuery, parseUsageQuery, type SnapshotQuery } from './query.ts';

const q = (text: string) => new URLSearchParams(text);

test('snapshot queries follow the contract grammar', () => {
  expect(parseSnapshotQuery(q(''))).toEqual({ tier: 'full', marks: [], attrs: [] });
  expect(parseSnapshotQuery(q('surface=status'))).toEqual({ surface: 'status', tier: 'glance', marks: [], attrs: [] });
  expect(parseSnapshotQuery(q('provider=local.omlx_2-a&runtime=llama-server&frame=0a1b2c3d&surface=page&tier=full&since=58&detail=server'
    + '&mark=started.1790690700000.deadbeef&mark=completed.1790690710000.deadbeef&attr=58.withheld.model-differs&attr=59.inferred.-&attr=60.armed.-&unknown=1')))
    .toEqual({ provider: 'local.omlx_2-a', runtime: 'llama-server', frame: '0a1b2c3d', surface: 'page', tier: 'full', since: 58, detail: 'server',
      marks: [{ phase: 'started', at: 1_790_690_700_000, tag: 'deadbeef' }, { phase: 'completed', at: 1_790_690_710_000, tag: 'deadbeef' }],
      attrs: [{ seq: 58, attr: 'withheld', reason: 'model-differs' }, { seq: 59, attr: 'inferred', reason: null }, { seq: 60, attr: 'armed', reason: null }] });
});

test('marks and attrs travel as one comma-joined value, because serviceRequest queries are Record<string, string>', () => {
  const marks: SnapshotQuery['marks'] = [{ phase: 'started', at: 1_790_690_700_000, tag: 'deadbeef' }, { phase: 'completed', at: 1_790_690_710_000, tag: 'deadbeef' }];
  const attrs: SnapshotQuery['attrs'] = [{ seq: 58, attr: 'withheld', reason: 'model-differs' }, { seq: 59, attr: 'inferred', reason: null }];
  const query = new URLSearchParams({ mark: encodeMarks(marks)!, attr: encodeAttrs(attrs)! });
  expect(parseSnapshotQuery(query)).toEqual({ tier: 'full', marks, attrs });
  expect(encodeMarks([])).toBeUndefined();
  expect(encodeAttrs([])).toBeUndefined();
  const many = Array.from({ length: 12 }, (_, index) => ({ seq: index + 1, attr: 'inferred' as const, reason: null }));
  expect(encodeAttrs(many)!.split(',')).toHaveLength(MAX_ATTRS);
  expect(encodeMarks(Array.from({ length: 6 }, () => marks[0]!))!.split(',')).toHaveLength(MAX_MARKS);
  expect(parseSnapshotQuery(q(`mark=${Array.from({ length: 5 }, () => 'started.1.deadbeef').join(',')}`))).toEqual({ error: 'bad_query', param: 'mark' });
  expect(parseSnapshotQuery(q('mark=started.1.deadbeef,'))).toEqual({ error: 'bad_query', param: 'mark' });
});

test('provider ids follow 1.6: up to 120 characters without control characters, and an empty one means Automatic', () => {
  // A selection a 1.6 panel persisted in `connection.selection` keeps working after the update.
  const persisted = { provider: 'My LM Studio (Bionic) · work', runtime: 'splash' as const };
  expect(parseSnapshotQuery(new URLSearchParams(persisted))).toEqual({ ...persisted, tier: 'full', marks: [], attrs: [] });
  expect(parseSnapshotQuery(q(`provider=${'x'.repeat(120)}`))).toMatchObject({ provider: 'x'.repeat(120) });
  expect(parseSnapshotQuery(q('provider=&runtime=vllm-mlx'))).toEqual({ runtime: 'vllm-mlx', tier: 'full', marks: [], attrs: [] });
  for (const bad of [`provider=${'x'.repeat(121)}`, 'provider=a%0Ab', 'provider=a%7Fb', 'provider=%00']) {
    expect(parseSnapshotQuery(q(bad)), bad).toEqual({ error: 'bad_query', param: 'provider' });
  }
  expect(parseTrendQuery(q('provider=my%20omlx'))).toMatchObject({ provider: 'my omlx' });
  expect(parseUsageQuery(q(`provider=${'x'.repeat(121)}`))).toEqual({ error: 'bad_query', param: 'provider' });
});

test('the S2 decision removed every sessions-dependent withhold reason from the grammar', () => {
  for (const reason of ['projects-loading', 'projects-error', 'too-many-projects', 'several-chats', 'subagent-running']) {
    expect(parseSnapshotQuery(q(`attr=58.withheld.${reason}`)), reason).toEqual({ error: 'bad_query', param: 'attr' });
  }
});

test.each([
  ['provider=a%0Db', 'provider'], [`provider=${'x'.repeat(121)}`, 'provider'], ['provider=a&provider=b', 'provider'], ['runtime=mlx', 'runtime'],
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
