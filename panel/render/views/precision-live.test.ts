import { expect, test } from 'bun:test';
import { parseSnapshotV2, type SnapshotV2 } from '../../../src/contract/snapshot.ts';
import { presentLive, type LiveView } from '../../present/live.ts';
import type { ScopeInput } from '../../present/scope.ts';
import { MOCK_NOW, mockBody } from '../../testing/mock-states.ts';
import { liveMarkup } from './live.ts';
import { sessionMarkup } from './session.ts';
import { liveChart } from '../chart.ts';

const scope = (patch: (snapshot: SnapshotV2) => void = () => {}, extra: Partial<ScopeInput> = {}): ScopeInput => {
  const snapshot = parseSnapshotV2(mockBody('decode'))!;
  patch(snapshot);
  return { now: MOCK_NOW, version: '5.0.0', snapshot, fresh: true, frame: null, paused: false,
    attribution: { kind: 'server-wide', reason: 'all-requests' }, chatRuntime: 'oMLX', last: null, samples: [],
    turnStartAt: null, measurementScope: 'engine', ...extra };
};
const render = (view: LiveView) => liveMarkup(view, new Set()).markup;

test('Session reserves no plot for sparse disconnected readings but preserves measured gaps in a usable trend', () => {
  const view = presentLive(scope()).hero!.instrument;
  const samples = [
    { at: MOCK_NOW - 11_000, rate: 21, phase: 'decode' as const, segment: 1 },
    { at: MOCK_NOW - 5_500, rate: 22, phase: 'decode' as const, segment: 2 },
    { at: MOCK_NOW, rate: 21.7, phase: 'decode' as const, segment: 3 },
  ];
  const disconnected = liveChart(samples, MOCK_NOW, null)!;
  expect(disconnected.line).not.toContain('L');
  const sparse = sessionMarkup(view, null, false, true, { chart: disconnected }).markup;
  expect(sparse).not.toContain('class="ws-plot"');
  expect(sparse).toContain('id="ws-signal" aria-label="" hidden');
  samples[1]!.segment = 1;
  const observed = liveChart(samples, MOCK_NOW, null)!;
  const ready = sessionMarkup(view, null, false, true, { chart: observed }).markup;
  expect(ready).toContain('class="ws-plot"');
  expect(ready).toContain(`d="${observed.line}"`);
});

test('precision identity uses reported model only, escapes it and keeps cloud delivery separate', () => {
  const view = presentLive(scope(snapshot => { snapshot.runtime.request!.model = 'Model <test> "27B"'; }));
  expect(render(view)).toContain('class="precision-model" translate="no">Model &lt;test&gt; &quot;27B&quot;');
  expect(render(view)).toContain('<span>oMLX</span>');
  const absent = presentLive(scope(snapshot => {
    snapshot.runtime.request!.model = null;
    snapshot.runtime.residency = [];
    for (const entry of snapshot.runtime.catalog) entry.loaded = false;
  }));
  expect(absent.hero?.model).toBeNull();
  expect(render(absent)).not.toContain('class="precision-model"');
  const cloud = presentLive(scope(undefined, { measurementScope: 'chat', chatIsLocal: false }));
  expect(render(cloud)).not.toContain('class="precision-engine"');
});

test('precision keeps the time basis, unit and current or retained meaning beside the measurement', () => {
  const view = presentLive(scope()), reading = view.hero!.instrument.measurement!;
  expect(render(view)).toContain('data-crossfade="Engine">Engine<button');
  expect(render(view)).toContain('average for this request');
  expect(render(view)).toContain('>tokens/s</span>');
  reading.label = 'Last reply · Engine'; reading.live = false;
  expect(render(view)).toContain('Last reply · Engine');
  expect(render(view)).toContain('data-live="false"');
  reading.label = 'This chat'; reading.basis = 'estimate';
  expect(render(view)).toContain('data-crossfade="This chat">This chat<button');
  expect(render(view)).toContain('>≈ 26.4</strong>');
  expect(render(view)).toContain('about 26.4 tokens per second');
  expect(render(view)).toContain('data-basis="estimate"');
});

test('the standard readout renders one escaped value without obsolete per-digit clip boxes', () => {
  const view = presentLive(scope()), reading = view.hero!.instrument.measurement!;
  reading.text = '25.6';
  const markup = render(view);
  expect(markup).toMatch(/<strong id="rate" aria-hidden="true" style="--reading-width:[\d.]+">25\.6<\/strong>/);
  for (const surface of [markup, sessionMarkup(view.hero!.instrument, null, false, true).markup, sessionMarkup(view.hero!.instrument, null, true, true).markup]) {
    expect(surface).not.toContain('digit-cell');
    expect(surface).not.toContain('data-roll-value');
  }
  reading.kind = 'elapsed'; reading.text = '<elapsed>';
  expect(render(view)).toContain('&lt;elapsed&gt;</strong>');
});

test('precision removes only a current support fact duplicated with the same basis', () => {
  const view = presentLive(scope()), support = view.hero!.instrument.support!;
  expect(render(view)).not.toContain('<p class="coverage-note">Engine · 612 tokens out');
  support.basis = 'derived';
  expect(render(view)).toContain('<p class="coverage-note">Engine · 612 tokens out');
  support.text = 'Engine · 612 / 800 tokens';
  expect(render(view)).toContain('Engine · 612 / 800 tokens');
  view.hero!.instrument.measurement!.live = false;
  support.text = 'Finished 3 minutes ago';
  expect(render(view)).toContain('Finished 3 minutes ago');
});

test('precision detail routes remain available', () => {
  const next = render(presentLive(scope()));
  expect(next).toContain('class="precision-detail-actions"');
  expect(next).toContain('data-action="open-run"');
  expect(next).toContain('data-action="open-server"');
});

test('a paused or stale precision trace names its endpoint as the last reading', () => {
  for (const extra of [{ paused: true }, { fresh: false }]) {
    const view = presentLive(scope(undefined, { ...extra, samples: [
      { at: MOCK_NOW - 1_000, rate: 23, phase: 'decode', segment: 1 },
      { at: MOCK_NOW, rate: 26, phase: 'decode', segment: 1 },
    ] }));
    expect(view.hero?.engineTrend?.current).toBe(false);
    expect(render(view)).toContain(', last reading 26');
    expect(render(view)).toContain('<span>last reading</span>');
    expect(render(view)).not.toContain(', now 26');
  }
});

test('accumulated engine history keeps its trace with an endpoint node', () => {
  const view = presentLive(scope(undefined, { samples: [
    { at: MOCK_NOW - 30_000, rate: 21, phase: 'decode', segment: 1 },
    { at: MOCK_NOW - 15_000, rate: 24, phase: 'decode', segment: 1 },
    { at: MOCK_NOW, rate: 26, phase: 'decode', segment: 1 },
  ] }));
  const chart = view.hero!.engineTrend!.chart!, next = render(view);
  expect(chart.points).toBe(3);
  expect(next).toContain(`class="trace" d="${chart.line}"`);
  expect(next).toContain('class="trace-endpoint"');
});
