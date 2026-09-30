process.env.TZ = 'UTC';
import { describe, expect, test } from 'bun:test';
import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { NextReplyState } from '../attribution/next-reply.ts';
import type { CaptureV2 } from '../captures/store.ts';
import { MOCK_TEXT } from '../testing/history-text.ts';
import { MOCK_NOW } from '../testing/mock-history.ts';
import { captureRate, capturesReport, nextReplyCapture, presentCaptures, type CapturesInput } from './captures-tab.ts';

const NOW = MOCK_NOW;
const step = (seq: number, fields: Partial<CompletionV2>): CompletionV2 =>
  ({ seq, finishedAt: NOW - 10_000, startedAt: NOW - 30_000, model: 'canary-model-name', basis: 'reported', overlapped: false, host: {}, ...fields });
const capture = (savedAt: number, fields: Partial<CaptureV2> = {}): CaptureV2 =>
  ({ v: 2, savedAt, kind: 'window', runtime: 'omlx', label: 'server-wide', state: 'finished', measurements: { decodeTps: 24.6, decodeBasis: 2, windowMs: 60_000 }, ...fields });
const input = (extra: Partial<CapturesInput> = {}): CapturesInput => ({ now: NOW, runtime: 'omlx', runtimeName: 'oMLX', completions: true, paused: false,
  next: { kind: 'idle' }, nextSaved: false, window: null, windowLength: 60_000, saved: [], legacy: [], reference: null, text: MOCK_TEXT, ...extra });
const result = (steps: CompletionV2[], attributed = true): NextReplyState => ({ kind: 'result', startedAt: NOW - 38_000, endedAt: NOW - 9_000, steps, attributed });

describe('Captures tab presenter (plan §5.9, G2 mock)', () => {
  test('Next reply offers to measure, counts down while armed and times the reply while measuring', () => {
    expect(presentCaptures(input()).next).toEqual(expect.objectContaining({ state: 'idle', note: 'Measures your next reply in this chat, then stops.',
      actions: [{ action: 'arm', label: 'Measure next reply', primary: true }] }));
    const armed = presentCaptures(input({ next: { kind: 'armed', at: NOW - 12_000 } })).next;
    expect(armed).toEqual(expect.objectContaining({ state: 'armed', chip: { attr: 'armed', text: 'Next reply · armed', reason: null }, time: { value: '1:48', suffix: ' left' },
      actions: [{ action: 'cancel', label: 'Cancel' }] }));
    expect(presentCaptures(input({ next: { kind: 'measuring', startedAt: NOW - 38_200, steps: [] } })).next)
      .toEqual(expect.objectContaining({ state: 'measuring', note: 'Measuring next reply', time: { value: '38 s', suffix: '' } }));
  });
  test('it won’t arm for another runtime, a runtime without replies, a paused monitor or a frame without chat activity', () => {
    expect(presentCaptures(input({ next: { kind: 'offer-watch', runtime: 'Splash' } })).next)
      .toEqual(expect.objectContaining({ state: 'offer-watch', note: 'Next reply needs this chat’s runtime.', actions: [{ action: 'watch', label: 'Watch Splash' }] }));
    expect(presentCaptures(input({ completions: false, runtimeName: 'Ollama' })).next).toEqual(expect.objectContaining({ state: 'unavailable',
      note: 'Ollama doesn’t report replies, so Next reply can’t measure one.', actions: [] }));
    expect(presentCaptures(input({ paused: true })).next.note).toBe('Resume monitoring to measure a reply.');
    expect(presentCaptures(input({ next: null })).next.note).toBe('Next reply needs an open chat in OpenChamber.');
    expect(presentCaptures(input({ next: { kind: 'cancelled', reason: 'switched' } })).next).toEqual(expect.objectContaining({ note: 'Cancelled: you switched chats.' }));
  });
  test('a result: token-weighted speed is derived, turn time observed; Save once, then Measure again', () => {
    const steps = [step(1, { outputTokens: 600, decodeTps: 30, ttftMs: 520, promptTokens: 50_000, cachedTokens: 40_000 }),
      step(2, { outputTokens: 604, decodeTps: 20, promptTokens: 3400, cachedTokens: 4800 })];
    const view = presentCaptures(input({ next: result(steps) })).next;
    expect(view.result).toEqual({ chip: { attr: 'armed', text: 'Next reply · armed', reason: null }, ago: '9 s ago',
      values: [{ text: '24.0 tok/s', basis: 'derived', note: 'derived' }, { text: '1,204 out', basis: 'reported', note: null }, { text: 'TTFT 0.52 s', basis: 'reported', note: null }],
      split: [{ text: 'Turn 29 s', basis: 'observed', note: 'observed' }] });
    expect(view.actions.map(a => a.label)).toEqual(['Save to Captures', 'Measure again']);
    expect(presentCaptures(input({ next: result(steps), nextSaved: true })).next.actions.map(a => a.label)).toEqual(['Measure again']);
  });
  test('a reply with a failed step stays server-wide and says why', () => {
    const steps = [step(1, { outputTokens: 100, decodeTps: 20, verdict: { attr: 'armed', at: NOW } }), step(2, { outputTokens: 100, decodeTps: 20, verdict: { attr: 'withheld', reason: 'overlap', at: NOW } })];
    const view = presentCaptures(input({ next: result(steps, false) })).next;
    expect(view.result!.chip).toEqual({ attr: 'server', text: 'Server-wide · overlapping requests', reason: 'overlap' });
    expect(view.note).toBe('A step couldn’t be tied to this chat, so this reply is server-wide.');
    expect(nextReplyCapture(result(steps, false) as never, 'omlx', NOW).label).toBe('server-wide');
  });
  test('a saved Next reply is numbers and a runtime kind; one step keeps its own basis, and a last-observed TTFT is left out', () => {
    const one = nextReplyCapture(result([step(1, { outputTokens: 1204, decodeTps: 25.1, ttftMs: 480, basis: 'last-observed' })]) as never, 'omlx', NOW);
    expect(one).toEqual({ v: 2, savedAt: NOW, kind: 'next-reply', runtime: 'omlx', label: 'armed', state: 'finished',
      measurements: { decodeTps: 25.1, decodeBasis: 3, outputTokens: 1204, wholeMs: 29_000, steps: 1 } });
    expect(captureRate(one)).toEqual({ tps: 25.1, basis: 'last-observed' });
    expect(JSON.stringify(one)).not.toMatch(/canary|model/);
  });
  test('saved captures: newest first, ≤ 12, runtime not model, with their label and a derived delta against the reference', () => {
    const saved = [capture(NOW - 3_600_000), capture(NOW - 1_000, { kind: 'next-reply', label: 'armed', measurements: { decodeTps: 25.1, decodeBasis: 0 } }),
      capture(NOW - 90_000_000, { measurements: { decodeTps: 61.3, windowMs: 30_000 }, runtime: 'splash', state: 'interrupted' })];
    const view = presentCaptures(input({ saved, reference: `v2:${NOW - 3_600_000}` })).saved;
    expect(view.right).toBe('3 of 12 · oldest replaced when full');
    expect(view.rows.map(r => [r.at, r.rate?.text, r.rate?.note, r.title, r.chip.text, r.comparing, r.delta?.text])).toEqual([
      ['14:04', '25.1 tok/s', null, 'Next reply · oMLX', 'Next reply · armed', false, '+2% vs reference'],
      ['13:05', '24.6 tok/s', 'observed', 'Window 60 s · oMLX', 'Server-wide · all requests', true, undefined],
      ['Sep 28', '61.3 tok/s', 'observed', 'Window 30 s · Splash (standalone) · partial', 'Server-wide · all requests', false, '+149% vs reference']]);
    const many = presentCaptures(input({ saved: Array.from({ length: 15 }, (_, i) => capture(NOW - i * 1000)) })).saved;
    expect(many.rows).toHaveLength(12);
    expect(presentCaptures(input()).saved).toEqual(expect.objectContaining({ empty: 'Nothing saved yet. Save a Next reply or a window to compare it later.', share: false }));
  });
  test('1.x captures show once, read-only, in their own list, even after the migration copied them', () => {
    const legacy = [capture(NOW - 86_400_000, { kind: 'snapshot', runtime: null, measurements: { generation: 23.4 } })];
    const view = presentCaptures(input({ saved: [legacy[0]!, capture(NOW - 1000)], legacy }));
    expect(view.saved.rows).toHaveLength(1);
    expect(view.legacy).toEqual({ right: 'Read-only · kept until MLX Scope 2.1', rows: [expect.objectContaining({ key: `v1:${NOW - 86_400_000}`, title: 'Snapshot · runtime not recorded',
      rate: { text: '23.4 tok/s', basis: 'reported', note: null } })] });
    expect(captureRate(capture(0, { measurements: { observedGeneration: 22 } }))).toEqual({ tps: 22, basis: 'observed' });
    expect(presentCaptures(input()).legacy).toBeNull();
  });
  test('Copy and Add to chat draft never carry a model name, even one the frame knows from the snapshot', () => {
    const report = capturesReport([capture(NOW, { measurements: { decodeTps: 24.6, decodeBasis: 2, outputTokens: 1480, completions: 3, memPeakBytes: 38_654_705_664 } })], '2.0.0', ['oMLX']);
    expect(report).toContain('MLX Scope 2.0.0 — saved captures');
    expect(report).toContain('24.6 tok/s (observed) 1,480 output tokens 3 replies finished RAM peak 36 GiB');
    expect(report).not.toContain('oMLX');
    expect(report).not.toMatch(/canary|Example/);
  });
});
