import { expect, test } from 'bun:test';
import { batchRow, DEFAULT_TRIAL_NOTES, trialChangeRow, waitRow, type SideRow } from '../history/ledger-schema.ts';
import { MOCK_NOW } from '../testing/mock-states.ts';
import { reply } from '../testing/rows.ts';
import { presentTrial, type TrialInput } from './trials.ts';

const baseS = Math.floor(MOCK_NOW / 1000), beforeS = baseS - 60, startS = baseS;
const notes = { ...DEFAULT_TRIAL_NOTES, soloDecodeTps: 40 };
const baseline = trialChangeRow(beforeS * 1000, 22_500_000_000, 38_000_000_000, 393_216, 0, false);
const current = trialChangeRow(startS * 1000, 21_000_000_000, 37_000_000_000, 262_144, 0, false);
const wait = (at: number, ms: number) => waitRow(at * 1000, ms, 'memory', 'splash', 0);
const trialInput = (side: SideRow[], extra: Partial<TrialInput> = {}): TrialInput => ({
  now: (startS + 60) * 1000,
  rows: [
    reply({ at: (beforeS + 5) * 1000, rt: 'splash', modelRef: 0, prompt: 170_000, decodeTps: 40, id: '5c1e0a7b.1' }),
    reply({ at: (startS + 5) * 1000, rt: 'splash', modelRef: 0, prompt: 170_000, decodeTps: 38.5, id: '5c1e0a7b.2' }),
  ],
  side, models: ['example/Example-27B-Splash'], notes, paused: false, canStart: true, ...extra,
});
const waits = (at: number, values: number[]): SideRow[] => values.map((value, index) => wait(at + index * 2, value));

test('trial uses the prior configuration stretch by default and reports Keep only when each measured gate passes', () => {
  const side: SideRow[] = [baseline, current,
    ...waits(beforeS + 1, [18_000, 19_000, 20_000, 21_000, 22_000]),
    ...waits(startS + 1, [10_000, 12_000, 14_000, 16_000, 18_000]),
    batchRow((startS + 30) * 1000, 197, 3),
  ];
  const card = presentTrial(trialInput(side));
  expect(card.verdict).toBe('keep');
  expect(card.baselineIndex).toBe(0);
  expect(card.baselineLabel).toContain('21.0 GiB');
  expect(card.gates.map(gate => gate.state)).toEqual(['pass', 'pass', 'pass', 'pass']);
  expect(card.gates[0]?.current).toContain('n=5');
  expect(card.gates[0]?.baseline).toContain('n=5');
  expect(card.gates[2]?.baseline).toContain('from your notes');
  expect(card.summary).toContain('advisory');
});

test('no overlap is unknown, never a pass; a measured share above 1% yields Revert', () => {
  const common = [baseline, current, ...waits(beforeS + 1, [18_000, 19_000, 20_000, 21_000, 22_000]),
    ...waits(startS + 1, [10_000, 12_000, 14_000, 16_000, 18_000])];
  const noOverlap = presentTrial(trialInput([...common, batchRow((startS + 30) * 1000, 200, 0)]));
  expect(noOverlap.verdict).toBe('not-enough-data');
  expect(noOverlap.gates[2]).toMatchObject({ state: 'unknown', current: 'Not enough readings' });
  const overlap = presentTrial(trialInput([...common, batchRow((startS + 30) * 1000, 199, 1)]));
  expect(overlap.verdict).toBe('revert');
  expect(overlap.gates[2]?.state).toBe('fail');
});

test('notes fill missing baselines, but insufficient waits, no two-chat sample or no long solo replies cannot Keep', () => {
  const manual = trialChangeRow(startS * 1000, 22_500_000_000, 38_000_000_000, 393_216, 0, true);
  const side: SideRow[] = [manual, ...waits(startS + 1, [10_000, 11_000, 12_000, 13_000, 14_000]),
    batchRow((startS + 30) * 1000, 197, 3)];
  const card = presentTrial(trialInput(side, { rows: [], notes: { ...DEFAULT_TRIAL_NOTES } }));
  expect(card.verdict).toBe('not-enough-data');
  expect(card.gates[0]?.baseline).toContain('from your notes');
  expect(card.gates[0]?.state).toBe('pass');
  expect(card.gates[3]?.state).toBe('unknown');
  expect(card.summary).toContain('No overlap is never a pass');
});

test('a zero-length automatic boundary is not offered as the prior comparison stretch', () => {
  const later = trialChangeRow(startS * 1000, 21_000_000_000, 37_000_000_000, 262_144, 0, true);
  const card = presentTrial(trialInput([baseline, current, later]));
  expect(card.baselines).toHaveLength(1);
  expect(card.baselineIndex).toBe(0);
  expect(card.baselineLabel).toContain('21.0 GiB');
});
