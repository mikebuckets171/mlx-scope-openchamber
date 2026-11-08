import { expect, test } from 'bun:test';
import { parseSnapshotV2, type SnapshotV2 } from '../../src/contract/snapshot.ts';
import { MOCK_NOW, mockBody } from '../testing/mock-states.ts';
import { createFakeStorage } from '../testing/storage.ts';
import { Ledger } from './ledger.ts';
import { TrialWatch, TRIAL_BATCH_INTERVAL_MS, trialConfigOf } from './trials.ts';

const model = 'example/Example-27B-Splash';
const snapshotAt = (now: number, change: Partial<{ model: string; expertCap: number; limit: number; context: number; single: number; multi: number }> = {}): SnapshotV2 => {
  const body = structuredClone(mockBody('splash-decode', { now })) as Record<string, any>;
  body.status = { state: 'ready', reason: null, params: {}, sinceAt: now - 60_000 };
  body.runtime.sampledAt = now;
  body.runtime.catalog = [{ name: change.model ?? model, format: 'splash', loaded: true, contextWindowTokens: change.context ?? 393_216 }];
  body.runtime.memory.room = { limitBytes: change.limit ?? 38_000_000_000, accounts: [
    { name: 'experts', currentBytes: change.expertCap ?? 22_500_000_000, capBytes: change.expertCap ?? 22_500_000_000 },
  ] };
  body.runtime.server.batches = { single: change.single ?? 100, multi: change.multi ?? 0 };
  body.capabilities['server.memory.room'] = { scope: 'server', basis: 'reported' };
  body.capabilities['server.batches'] = { scope: 'server', basis: 'reported' };
  const snapshot = parseSnapshotV2(body);
  if (!snapshot) throw new Error('Synthetic Splash schema-8 fixture did not parse');
  return snapshot;
};
const makeLedger = async (at: number) => {
  const time = { now: at };
  const ledger = new Ledger({ storage: createFakeStorage(), now: () => time.now });
  await ledger.start();
  return { ledger, time };
};

test('reads the loaded Splash model and plan from the status snapshot only', () => {
  const snapshot = snapshotAt(MOCK_NOW);
  expect(trialConfigOf(snapshot)).toEqual({ model, expertCapBytes: 22_500_000_000, limitBytes: 38_000_000_000, contextWindowTokens: 393_216 });
  expect(trialConfigOf(null)).toBeNull();
  const nonSplash = structuredClone(snapshot);
  nonSplash.connection.runtime = 'omlx';
  expect(trialConfigOf(nonSplash)).toBeNull();
  const notReady = structuredClone(snapshot);
  notReady.status.state = 'recovering';
  expect(trialConfigOf(notReady)).toBeNull();
});

test('first ready reading establishes a baseline; a plan, context or model change opens an automatic boundary', async () => {
  const { ledger } = await makeLedger(MOCK_NOW), watch = new TrialWatch();
  await watch.observe(snapshotAt(MOCK_NOW), ledger, MOCK_NOW);
  expect((await ledger.readSide()).filter(row => row[0] === 'c')).toEqual([
    ['c', Math.floor(MOCK_NOW / 1000), 22_500_000_000, 38_000_000_000, 393_216, 0, false],
  ]);
  await watch.observe(snapshotAt(MOCK_NOW + 20_000, { expertCap: 21_000_000_000, limit: 37_000_000_000, context: 262_144 }), ledger, MOCK_NOW + 20_000);
  const changes = (await ledger.readSide()).filter(row => row[0] === 'c');
  expect(changes).toHaveLength(2);
  expect(changes[1]).toEqual(['c', Math.floor((MOCK_NOW + 20_000) / 1000), 21_000_000_000, 37_000_000_000, 262_144, 0, false]);
  expect((await ledger.readSide()).some(row => row[0] === 'k')).toBe(false);
});

test('manual starts create a boundary; batch counts are saved as bounded deltas while ready', async () => {
  const { ledger } = await makeLedger(MOCK_NOW), watch = new TrialWatch();
  const initial = snapshotAt(MOCK_NOW);
  await watch.observe(initial, ledger, MOCK_NOW);
  expect(await watch.start(snapshotAt(MOCK_NOW + 2_000), ledger, MOCK_NOW + 2_000)).toBe(true);
  expect((await ledger.readSide()).filter(row => row[0] === 'c').at(-1)).toEqual([
    'c', Math.floor((MOCK_NOW + 2_000) / 1000), 22_500_000_000, 38_000_000_000, 393_216, 0, true,
  ]);
  await watch.observe(snapshotAt(MOCK_NOW + TRIAL_BATCH_INTERVAL_MS + 2_000, { single: 140, multi: 1 }), ledger, MOCK_NOW + TRIAL_BATCH_INTERVAL_MS + 2_000);
  expect((await ledger.readSide()).filter(row => row[0] === 'k')).toEqual([
    ['k', Math.floor((MOCK_NOW + TRIAL_BATCH_INTERVAL_MS + 2_000) / 1000), 40, 1],
  ]);
});

test('history clear reset makes the next ready reading a new baseline, and paused History records no manual trial', async () => {
  const { ledger, time } = await makeLedger(MOCK_NOW), watch = new TrialWatch();
  await watch.observe(snapshotAt(MOCK_NOW), ledger, MOCK_NOW);
  time.now = MOCK_NOW + 1_000;
  await ledger.clear(); watch.reset();
  await watch.observe(snapshotAt(MOCK_NOW + 2_000, { model: 'example/Other-Model' }), ledger, MOCK_NOW + 2_000);
  expect((await ledger.readSide()).filter(row => row[0] === 'c')).toHaveLength(1);
  ledger.setPaused(true);
  expect(await watch.start(snapshotAt(MOCK_NOW + 4_000), ledger, MOCK_NOW + 4_000)).toBe(false);
  expect((await ledger.readSide()).filter(row => row[0] === 'c')).toHaveLength(1);
});
