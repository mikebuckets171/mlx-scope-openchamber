import type { HeaderView } from '../present/header.ts';
import type { HostView, LiveView, ProgressView } from '../present/live.ts';
import type { ServerView } from '../present/server.ts';
import type { Dom } from './dom.ts';

export const renderHeader = (dom: Dom, shell: HTMLElement, view: HeaderView): void => {
  const { coverage, runtime, engine, empty, phase, stale } = view.dataset;
  Object.assign(shell.dataset, { coverage, runtime, engine });
  dom.text('activity-label', view.activityLabel);
  dom.node('instrument').setAttribute('aria-label', view.instrumentLabel);
  shell.dataset.empty = empty;
  dom.hidden('instrument', view.instrumentHidden);
  dom.hidden('connection-diagnosis', view.diagnosisHidden);
  dom.text('connection-message', view.connectionMessage);
  dom.hidden('coverage-note', view.coverageNoteHidden);
  dom.text('coverage-note', view.coverageNote);
  shell.dataset.phase = phase;
  shell.dataset.stale = stale;
  dom.text('connection', view.connection);
  dom.text('phase', view.phase);
  dom.text('model', view.model);
  dom.node('model').title = view.modelTitle;
  dom.hidden('splash-model-detail', !view.splashDetail);
  dom.text('splash-model-detail', view.splashDetail);
  dom.text('notice', view.notice);
  dom.hidden('notice', view.noticeHidden);
  dom.text('freshness', view.freshness);
  (dom.node('save-snapshot') as HTMLButtonElement).disabled = view.saveDisabled;
};

export const renderProgress = (dom: Dom, view: ProgressView | null): void => {
  dom.hidden('prefill-progress', view === null);
  if (!view) return;
  dom.text('prefill-remaining', view.remaining);
  dom.text('prefill-completed', view.completed);
  dom.text('prefill-state', view.state);
  dom.node('prefill-progress').dataset.held = String(view.held);
  const track = dom.node('prefill-track');
  if (view.valueNow === null) track.removeAttribute('aria-valuenow');
  else track.setAttribute('aria-valuenow', view.valueNow);
  track.setAttribute('aria-valuetext', view.valueText);
  (track.firstElementChild as HTMLElement).style.width = `${view.percent ?? 0}%`;
  dom.text('prefill-counts', view.counts);
};

export const renderLive = (dom: Dom, view: LiveView): void => {
  dom.text('estimate-source', view.estimateSource);
  dom.hidden('recent-speed', view.recentSpeedHidden);
  dom.text('rate', view.rate);
  dom.node('rate').classList.toggle('is-word', view.rateIsWord);
  dom.text('unit', view.unit);
  dom.text('activity', view.activity);
  dom.hidden('request-output', view.requestOutputHidden);
  dom.text('request-output', view.requestOutput);
  const headroom = view.headroom;
  dom.hidden('context-headroom', headroom === null);
  dom.text('context-remaining', headroom?.remaining ?? '—');
  dom.text('context-accounted', headroom?.accounted ?? 'Not reported');
  dom.meter('context-used-bar', headroom?.percent ?? null);
  const m = view.metrics;
  dom.node('context').parentElement!.hidden = m.contextHidden;
  dom.node('reuse').parentElement!.hidden = m.reuseHidden;
  dom.text('context', m.context); dom.text('context-detail', m.contextDetail);
  dom.text('reuse', m.reuse); dom.text('reuse-detail', m.reuseDetail);
  dom.meter('context-bar', m.contextBar); dom.meter('reuse-bar', m.reuseBar);
  dom.text('requests', m.requests); dom.text('queue', m.queue);
  dom.hidden('signal', view.signalHidden);
  dom.hidden('activity', view.activityHidden);
  dom.text('output', m.output); dom.text('elapsed', m.elapsed);
};

/** The host card; with no reading at all its last text stays behind the hidden section. */
export const renderHost = (dom: Dom, view: HostView): void => {
  dom.hidden('machine', view.hidden);
  dom.node('machine').dataset.stale = String(view.stale);
  const card = view.card;
  if (card) {
    dom.text('machine-title', card.title);
    dom.text('hardware', card.hardware);
    dom.text('machine-freshness', card.freshness);
    dom.text('cpu', card.cpu); dom.meter('cpu-bar', card.cpuBar);
    dom.text('ram', card.ram); dom.meter('ram-bar', card.ramBar);
    dom.hidden('mac-memory', card.macHidden);
    dom.text('wired', card.wired); dom.text('compressed', card.compressed); dom.text('swap', card.swap);
    dom.text('native-freshness', card.nativeFreshness);
  }
};

export const renderServer = (dom: Dom, view: ServerView): void => {
  const { memory, session, details } = view;
  dom.text('process-label', memory.processLabel);
  dom.text('model-label', memory.modelLabel);
  dom.text('runtime-memory-title', memory.title);
  dom.text('runtime-memory-note', memory.note);
  dom.text('session-title', session.title);
  dom.text('stats-label-one', session.labels[0]); dom.text('stats-label-two', session.labels[1]); dom.text('stats-label-three', session.labels[2]);
  dom.node('average-cache').dataset.warn = String(session.warn);
  dom.text('average-decode', session.values[0]); dom.text('average-prefill', session.values[1]); dom.text('average-cache', session.values[2]);
  dom.node('session-stats').dataset.stale = String(session.stale);
  dom.text('session-stats-state', session.state);
  dom.text('uptime', session.uptime);
  dom.hidden('runtime-details', details.hidden);
  dom.text('process-memory', memory.process);
  dom.text('model-memory', memory.model);
  dom.text('ssd-cache', details.ssdCache);
  dom.hidden('runtime-memory', memory.hidden);
  dom.node('runtime-memory').dataset.stale = String(memory.stale);
  dom.text('runtime-memory-source', memory.source);
  dom.text('pressure', details.guard);
  dom.text('cache-lookup', details.lookup);
};
