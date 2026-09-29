import type { ChartInspector } from '../chart-inspector.ts';
import { count, rate } from '../present/format.ts';
import type { ReadingPhase } from '../present/reading.ts';
import { traceGeometry, type SignalHistory } from '../signal.ts';
import type { Dom } from './dom.ts';

// Reuse path elements when the segment count is unchanged.
const drawPaths = (group: Element, paths: string[]): void => {
  while (group.childElementCount > paths.length) group.lastElementChild!.remove();
  paths.forEach((path, index) => {
    let target = group.children[index];
    if (!target) {
      target = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      group.append(target);
    }
    target.setAttribute('d', path);
  });
};

/** The 90 s throughput trace: one phase and one basis at a time, gaps left open. */
export const drawSignal = (dom: Dom, signal: SignalHistory, inspector: ChartInspector, now: number, live: boolean, phase: ReadingPhase): void => {
  signal.prune(now);
  const tracePhase = phase === 'prefill' ? 'prefill' : phase === 'decode' ? 'decode' : signal.points.at(-1)?.phase ?? 'decode';
  const basis = signal.points.filter(point => point.phase === tracePhase).at(-1)?.basis;
  const points = signal.points.filter(point => point.phase === tracePhase && point.basis === basis);
  const geometry = traceGeometry(points, now);
  drawPaths(dom.node('trace-area'), geometry.areas);
  drawPaths(dom.node('trace'), geometry.paths);
  const cursor = dom.node('cursor');
  if (geometry.latest) {
    cursor.removeAttribute('hidden');
    cursor.setAttribute('cx', String(geometry.latest.x)); cursor.setAttribute('cy', String(geometry.latest.y));
  } else cursor.setAttribute('hidden', '');
  dom.hidden('chart-empty', points.length > 0);
  const figure = dom.node('signal');
  figure.dataset.points = String(points.length);
  dom.text('chart-title', tracePhase === 'prefill' ? 'Prefill · reported speed' : basis === 'observed' ? 'Generation · recent output' : 'Generation · request average');
  dom.text('ceiling', `${count(geometry.upper)} tok/s`);
  inspector.update(points, now, geometry.upper);
  dom.text('chart-state', points.length ? live ? 'Live observations' : 'Recent observations · not live' : 'Observed samples only');
  figure.dataset.live = String(live);
  figure.setAttribute('aria-label', points.length ? `${tracePhase} throughput over 90 seconds. ${points.length} observations. Latest ${rate(points.at(-1)?.rate)}. Gaps are not zero.` : 'No observed throughput in the last 90 seconds.');
};

/** Clear both host traces, as when observations are discarded. */
export const clearHostTraces = (dom: Dom): void => {
  dom.node('cpu-history').setAttribute('d', '');
  dom.node('ram-history').setAttribute('d', '');
};
