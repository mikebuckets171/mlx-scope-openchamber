import { expect, test } from 'bun:test';
import { WITHHOLD_REASONS } from '../../src/contract/reasons.ts';
import type { AttributionLabel } from './join.ts';
import { ALTERNATING, attributionWhy } from './why.ts';

const LABELS: AttributionLabel[] = [{ kind: 'inferred' }, { kind: 'armed' },
  ...[...WITHHOLD_REASONS, 'all-requests' as const].map(reason => ({ kind: 'server-wide' as const, reason }))];

test('every inferred and armed ⓘ says another chat alternating on the server cannot be ruled out', () => {
  for (const kind of ['inferred', 'armed'] as const) for (const live of [true, false]) {
    const [title, first, second] = attributionWhy({ kind }, 'Splash', live);
    expect(title).toBe(kind === 'inferred' ? 'Likely this chat' : 'Next reply');
    expect(first).toContain('Splash');
    expect(second).toContain(ALTERNATING);
  }
  expect(ALTERNATING).toBe('Another chat may have used the same server between readings.');
});

test('every server-wide reason has its words, and none claims more than Scope can see', () => {
  for (const label of LABELS) for (const live of [true, false]) {
    const text = attributionWhy(label, 'oMLX', live, { provider: 'splish' });
    if (label.kind === 'server-wide') expect(text[0]).toBe('All server activity');
    expect(text[1].length).toBeGreaterThan(20);
    const all = text.join(' ');
    expect(all).not.toMatch(/VRAM|video memory|only this chat|Qwen|undefined|null/);
  }
  expect(attributionWhy({ kind: 'server-wide', reason: 'other-provider' }, 'oMLX', false, { provider: 'splish' })[2]).toBe('Watch splish to label this chat’s readings.');
  expect(attributionWhy({ kind: 'server-wide', reason: 'other-provider' }, 'oMLX', false)[1]).toContain('another connection');
});
