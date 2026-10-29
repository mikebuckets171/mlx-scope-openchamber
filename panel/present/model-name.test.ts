import { expect, test } from 'bun:test';
import { parseSnapshotV2, type SnapshotV2 } from '../../src/contract/snapshot.ts';
import { MOCK_NOW, mockBody } from '../testing/mock-states.ts';
import { MOCK_TEXT } from '../testing/history-text.ts';
import { mockAccounting } from '../testing/mock-history.ts';
import { reply } from '../testing/rows.ts';
import { alertCopy } from './copy.ts';
import { presentHistory } from './history.ts';
import { presentLive } from './live.ts';
import { modelDisplayName } from './model-name.ts';
import { presentRecordedRun } from './run.ts';
import { modelOf, SERVER_WIDE } from './scope.ts';
import { presentServer } from './server.ts';

const MODEL = 'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF', NAME = 'Qwen3.8-Flash-Next';
const NAMES = [{ model: MODEL, name: NAME }, { model: 'unsloth/Ornith-1.5-122B-GGUF', name: 'Ornith-1.5-122B' }];

test('OpenCode names match the reported ID, its quantization variant and the provider-prefixed form only', () => {
  for (const model of [MODEL, `${MODEL}:IQ3_XXS`, `splash/${MODEL}`, `splash/${MODEL}:IQ3_XXS`]) expect(modelDisplayName(model, NAMES, 'splash')).toBe(NAME);
  expect(modelDisplayName('unsloth/Ornith-1.5-122B-GGUF:UD-Q3_K_XL', NAMES)).toBe('Ornith-1.5-122B');
  for (const model of ['SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF', 'other/Qwen3.8-Flash-Next-GSQ-RCO-GGUF', `other/${MODEL}`, 'Qwen3.8-Flash-Next', MODEL.toLowerCase()])
    expect(modelDisplayName(model, NAMES, 'splash')).toBe(model);
  expect(modelDisplayName(`splash/${MODEL}`, NAMES)).toBe(`splash/${MODEL}`);
  expect(modelDisplayName(MODEL, undefined)).toBe(MODEL);
  expect(modelDisplayName(MODEL, [])).toBe(MODEL);
});

test('the snapshot contract keeps at most 32 bounded names and drops malformed ones', () => {
  const body = mockBody('splash-decode') as { connection: Record<string, unknown> };
  body.connection.modelNames = [...NAMES, { model: '', name: 'x' }, { model: 'a' }, { name: 'b' }, 'c',
    { model: '/private/models/Local-GGUF', name: 'Local' }, { model: 'long', name: 'n'.repeat(200) },
    ...Array.from({ length: 40 }, (_, i) => ({ model: `m${i}`, name: `M${i}` }))];
  const names = parseSnapshotV2(body)!.connection.modelNames!;
  expect(names).toHaveLength(32);
  expect(names.slice(0, 4)).toEqual([...NAMES, { model: 'Local-GGUF', name: 'Local' }, { model: 'long', name: 'n'.repeat(80) }]);
  delete body.connection.modelNames;
  expect(parseSnapshotV2(body)!.connection).not.toHaveProperty('modelNames');
});

const named = (): SnapshotV2 => {
  const snapshot = parseSnapshotV2(mockBody('splash-decode'))!;
  snapshot.connection.modelNames = NAMES;
  snapshot.runtime.catalog[0]!.name = MODEL;
  if (snapshot.runtime.request) snapshot.runtime.request.model = `${MODEL}:IQ3_XXS`;
  return snapshot;
};

test('live, server and alerts show the OpenCode name while the snapshot keeps the runtime identity', () => {
  const snapshot = named(), before = JSON.stringify(snapshot);
  const live = presentLive({ now: MOCK_NOW, version: 'fixture', snapshot, fresh: true, paused: false, frame: null,
    attribution: SERVER_WIDE, chatRuntime: null, last: null, samples: [], turnStartAt: null });
  expect(live.hero?.title).toBe(NAME);
  const catalog = presentServer(snapshot, MOCK_NOW).cards.find(card => card.key === 'catalog')!;
  expect(catalog.blocks[0]).toMatchObject({ items: [{ title: NAME }] });
  expect(alertCopy('model-unloaded', { model: MODEL }, NAMES)[0]).toBe(`${NAME} was unloaded`);
  expect(alertCopy('model-unloaded', { model: MODEL })[0]).toBe(`${MODEL} was unloaded`);
  expect(modelOf(snapshot)).toStartWith(MODEL);
  expect(JSON.stringify(snapshot)).toBe(before);
});

test('history and recorded details name models without changing the raw dictionary or row references', () => {
  const models = [MODEL, 'Other model'];
  const rows = [reply({ at: MOCK_NOW - 1000, modelRef: 1 }), reply({ at: MOCK_NOW, modelRef: 0 })];
  const before = JSON.stringify({ models, rows });
  const history = presentHistory({ now: MOCK_NOW, trend: null, usage: null, rows, models, baselines: new Map(), flags: [], storage: mockAccounting(),
    paused: false, retentionDays: 30, alertLog: [{ id: 'model-unloaded', severity: 'info', since: MOCK_NOW - 5000, until: null, params: { model: MODEL } }],
    runtimeName: 'Splash', model: MODEL, modelNames: NAMES, text: MOCK_TEXT });
  expect(history.entries[0]).toMatchObject({ kind: 'reply', model: NAME });
  expect(history.baseline.model).toBe(NAME);
  expect(history.alertLog[0]!.text).toContain(NAME);
  expect(presentRecordedRun(rows[1]!, models, MOCK_NOW, NAMES).identity).toContain(NAME);
  expect(presentRecordedRun(rows[1]!, models, MOCK_NOW).identity).toContain(MODEL);
  expect(JSON.stringify({ models, rows })).toBe(before);
});
