import { describe, expect, test } from 'bun:test';
import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import { windowCapture } from '../present/captures-tab.ts';
import { mockSnapshot } from '../testing/mock-history.ts';
import { WINDOW_GAP_MS, WindowCapture, windowRate } from './window.ts';

const BASE = mockSnapshot('decode'), T0 = BASE.serverNow;
const GiB = 2 ** 30;
/** One poll `ms` after the click, with the request's output so far. */
const poll = (ms: number, tokens: number, patch: (s: SnapshotV2) => void = () => {}): SnapshotV2 => {
  const s = structuredClone(BASE);
  s.serverNow = T0 + ms; s.runtime.sampledAt = T0 + ms;
  s.runtime.request = { ...s.runtime.request!, outputTokens: tokens, elapsedMs: 60_000 + ms };
  s.host = { ...s.host!, sampledAt: T0 + ms, cpuFraction: 0.2 + (ms / 1000 % 3) / 10, memUsedBytes: 36 * GiB + ms, mac: { ...s.host!.mac!, swapUsedBytes: GiB + ms * 1000 } };
  patch(s);
  return s;
};
const done = (seq: number, at: number): CompletionV2 => ({ seq, finishedAt: at, startedAt: at - 5000, model: 'canary-model-name', basis: 'last-observed', outputTokens: 99, overlapped: false, host: {} });
const run = (capture: WindowCapture, polls: SnapshotV2[]): void => polls.forEach(s => capture.observe(s));

describe('Captures window (30/60 s, server-wide)', () => {
  test('averages output increments of the one decoding request after the click, and finishes at the target', () => {
    const capture = new WindowCapture();
    expect(capture.start(poll(0, 1000), 30_000)).toBe(true);
    run(capture, Array.from({ length: 60 }, (_, i) => poll((i + 1) * 500, 1000 + (i + 1) * 12)));
    const state = capture.current!;
    expect(state.status).toBe('finished');
    expect(state.endedAt - state.startedAt).toBe(30_000);
    // Intervals start at the first reading after the click (1.6's rule): 59 of them.
    expect(state.decodeTokens).toBe(708);
    expect(windowRate(state)).toBeCloseTo(24, 5);
    expect(state.samples).toBe(61);
    expect(state.cpuSamples).toBe(61);
    expect(state.memPeakBytes).toBe(36 * GiB + 30_000);
    expect(state.swapEndBytes! - state.swapStartBytes!).toBe(30_000_000);
  });
  test('a cached reading from before the click is no sample, so stopping at once leaves nothing to save', () => {
    const capture = new WindowCapture();
    expect(capture.start(poll(0, 1000, s => { s.runtime.sampledAt = T0 - 800; s.host!.sampledAt = T0 - 800; }), 30_000)).toBe(true);
    expect(capture.current).toEqual(expect.objectContaining({ samples: 0, footprintPeakBytes: null, cpuSamples: 0 }));
    capture.stop();
    expect(capture.current).toEqual(expect.objectContaining({ status: 'interrupted', samples: 0 }));
  });
  test('a late poll cannot supply the unobserved end of the window', () => {
    const capture = new WindowCapture();
    capture.start(poll(0, 1000), 30_000);
    run(capture, [poll(10_000, 1240), poll(20_000, 1480), poll(31_000, 1744)]);
    expect(capture.current).toEqual(expect.objectContaining({ status: 'finished', endedAt: T0 + 30_000, decodeTokens: 240, samples: 3 }));
  });
  test('a new request restarts the interval; two requests at once are skipped, never an abort', () => {
    const capture = new WindowCapture();
    capture.start(poll(0, 1000), 60_000);
    run(capture, [poll(1000, 1024), poll(2000, 10, s => { s.runtime.request!.elapsedMs = 500; }), poll(3000, 34, s => { s.runtime.request!.elapsedMs = 1500; }),
      poll(4000, 58, s => { s.runtime.server.active = 2; }), poll(5000, 82, s => { s.runtime.request!.elapsedMs = 3500; })]);
    // 1000→2000 restarts (elapsed fell), 2000→3000 counts, 3000→4000 overlaps, 4000→5000 has no clean start.
    expect(capture.current).toEqual(expect.objectContaining({ status: 'recording', decodeTokens: 24, decodeMs: 1000 }));
  });
  test('replies count only when they finish inside the window', () => {
    const capture = new WindowCapture();
    capture.start(poll(0, 1000, s => { s.completions.items = [done(7, T0 - 1000)]; }), 30_000);
    run(capture, [poll(1000, 1024, s => { s.completions.items = [done(7, T0 - 1000), done(8, T0 + 800)]; }),
      poll(2000, 1048, s => { s.completions.items = [done(8, T0 + 800), done(9, T0 + 1900)]; })]);
    expect(capture.current!.completions).toBe(2);
  });
  test('a monitoring gap, another connection or an unreadable runtime stops it as a partial observation', () => {
    const cases: Array<[SnapshotV2, string]> = [
      [poll(1000 + WINDOW_GAP_MS + 1, 1100), 'Monitoring gap'],
      [poll(1000, 1100, s => { s.connection.generation += 1; }), 'The connection or server changed'],
      [poll(1000, 1100, s => { s.status = { state: 'failing', reason: 'runtime_unreachable', params: {} }; }), 'The server stopped answering'],
    ];
    for (const [next, reason] of cases) {
      const capture = new WindowCapture();
      capture.start(poll(0, 1000), 30_000);
      capture.observe(next);
      expect(capture.current).toEqual(expect.objectContaining({ status: 'interrupted', stopReason: reason }));
      expect(capture.recording).toBe(false);
    }
  });
  test('it will not start while another records or the server cannot be read; Stop keeps a partial result', () => {
    const capture = new WindowCapture();
    expect(capture.start(poll(0, 1000, s => { s.status = { state: 'failing', reason: 'runtime_unreachable', params: {} }; }), 30_000)).toBe(false);
    expect(capture.start(poll(0, 1000), 30_000)).toBe(true);
    expect(capture.start(poll(0, 1000), 60_000)).toBe(false);
    capture.clear();
    expect(capture.current).not.toBeNull();
    capture.observe(poll(1000, 1030)); capture.observe(poll(2000, 1060));
    capture.stop();
    expect(capture.current).toEqual(expect.objectContaining({ status: 'interrupted', stopReason: 'Stopped by you', decodeTokens: 30 }));
    capture.clear();
    expect(capture.current).toBeNull();
  });
  test('a saved window is numbers and a runtime kind: never a model name (capture.v2 is a share sink)', () => {
    const capture = new WindowCapture();
    capture.start(poll(0, 1000, s => { s.runtime.request!.model = 'canary-model-name'; }), 30_000);
    run(capture, Array.from({ length: 60 }, (_, i) => poll((i + 1) * 500, 1000 + (i + 1) * 12, s => { s.completions.items = [done(100 + i, T0 + i * 500)]; })));
    const saved = windowCapture(capture.current!, T0 + 31_000);
    expect(saved).toEqual({ v: 2, savedAt: T0 + 31_000, kind: 'window', runtime: 'omlx', label: 'server-wide', state: 'finished', measurements: expect.objectContaining({
      decodeTps: 24, decodeBasis: 2, outputTokens: 708, windowMs: 30_000, observedMs: 30_000, completions: 60, samples: 61 }) });
    expect(JSON.stringify(saved)).not.toMatch(/canary|Example|model/);
  });
});
