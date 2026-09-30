import { connectionsMarkup } from '../connections-view.ts';
import { APPROVAL, RESTART } from '../present/copy.ts';
import type { HeaderView } from '../present/header.ts';
import { html, raw, type Raw } from './html.ts';
import { ICON } from './views/parts.ts';
import type { Tab } from './views/types.ts';

// The rail panel's and the page's static shell (G2 mock, 1.6 structure): masthead with the status pill, pause and ⋯,
// the segmented tabs, one tabpanel per tab, and the footer. Polls patch the pill and the active panel only.

export const TABS: ReadonlyArray<readonly [Tab, string]> = [['live', 'Live'], ['server', 'Server'], ['history', 'History'], ['captures', 'Captures']];
/** On the page at ≥ 900 px, Live and History share one tab as two columns. */
export const PAGE_TABS: ReadonlyArray<readonly [Tab, string]> = [['live', 'Live · History'], ['server', 'Server'], ['captures', 'Captures']];

const menu = html`<details class="monitor-menu" id="monitor-menu"><summary class="icon-btn" aria-label="More options">${ICON.more}</summary>
  <div class="monitor-menu-content">
    <button id="refresh" type="button" disabled><span class="menu-check" aria-hidden="true"></span>Refresh readings</button>
    <button id="compact" type="button" aria-pressed="false"><span class="menu-check" aria-hidden="true"></span>Compact view</button>
    <button id="efficiency" type="button" aria-pressed="false"><span class="menu-check" aria-hidden="true"></span>Energy-saving updates</button>
    <button id="toasts" type="button" aria-describedby="toasts-state"><span class="menu-check" aria-hidden="true"></span>Alert toasts: <span id="toasts-state">critical only</span></button>
    <div id="share-actions" class="share-actions" aria-label="Share readings"></div>
    <button id="connection-change" type="button" aria-expanded="false" aria-controls="connection-setup"><span class="menu-check" aria-hidden="true"></span>Connection…</button>
    <p class="menu-about"><span id="cadence">Adaptive updates</span><span>Local · read-only · server-wide unless labelled</span></p>
  </div></details>`;

export const shellMarkup = (): Raw => html`<main class="scope" id="scope" aria-labelledby="scope-title" hidden>
  <header class="masthead">
    <div class="brand">${ICON.mark}<h1 id="scope-title">MLX <span>Scope</span></h1></div>
    <div class="status-pill" id="status-pill"><span class="connection-dot" aria-hidden="true"></span><span class="phase" id="phase">Connecting</span><span class="status-sep" id="status-sep" aria-hidden="true">·</span><span class="conn" id="connection" role="status">Local runtime</span></div>
    <div class="monitor-controls"><button class="icon-btn" id="pause" type="button" aria-pressed="false" aria-label="Pause monitoring">${ICON.pause}</button>${menu}</div>
  </header>
  ${raw(connectionsMarkup)}
  <details class="connection-help" id="connection-help"><summary>Connection help</summary><p id="connection-result" role="status">Check whether OpenChamber has started the extension service. This does not change your configuration.</p><div class="insight-actions"><button id="check-connection" type="button">Check extension service</button><button id="connection-guide" type="button">Setup guide</button></div></details>
  <button id="connection-configure" type="button" hidden>Connection…</button>
  <p id="action-status" class="action-status" role="status" hidden></p>
  <div id="frame-card"></div>
  <nav class="workspace-nav" id="workspace-nav" aria-label="Scope workspaces"><div class="tablist" role="tablist" id="tablist"></div></nav>
  <div id="panels">${TABS.map(([id]) => html`<div class="view" role="tabpanel" id="panel-${id}" aria-labelledby="tab-${id}" tabindex="0" hidden></div>`)}</div>
  <div class="page-cols" id="page-cols" hidden></div>
  <section class="compact-glance" id="compact-glance" aria-label="MLX Scope glance" hidden></section>
  <footer><span>MLX Scope <span id="scope-version"></span></span><span id="freshness">No reading yet</span></footer>
</main>`;

export const tabsMarkup = (tabs: ReadonlyArray<readonly [Tab, string]>, active: Tab): Raw => html`${tabs.map(([id, label]) =>
  html`<button class="tab" role="tab" type="button" id="tab-${id}" data-tab="${id}" aria-controls="panel-${id}" aria-selected="${String(id === active)}" tabindex="${id === active ? 0 : -1}">${label}</button>`)}`;

const steps = (list: readonly string[]): Raw => html`<ol class="steps">${list.map(step => html`<li>${step}</li>`)}</ol>`;
/** Needs approval (NO_SERVICE after an update) and needs a restart (version skew): nothing else is shown. */
export const frameCardMarkup = (card: 'approval' | 'restart'): Raw => card === 'approval'
  ? html`<div class="view"><section class="approval-card" id="approval-card" aria-labelledby="approval-title"><h2 id="approval-title">${APPROVAL.title}</h2><p>${APPROVAL.body}</p>${steps(APPROVAL.steps)}
    <details class="grant" id="grant" open><summary>What the approval lists, and why</summary><dl class="kv">${APPROVAL.grant.map(([what, paths, note]) =>
      html`<div><dt>${what}</dt><dd>${paths.split(', ').map((path, index) => html`${index ? ', ' : ''}<code>${path}</code>`)}${note ? ` · ${note}` : ''}</dd></div>`)}</dl></details>
    <p class="insight-note">${APPROVAL.note}</p></section></div>`
  : html`<div class="view"><section class="approval-card" id="restart-card" aria-labelledby="restart-title"><h2 id="restart-title">${RESTART.title}</h2><p>${RESTART.body}</p>${steps(RESTART.steps)}
    <p class="insight-note">${RESTART.note}</p></section></div>`;

/** The pill and the frame-wide data attributes the accent follows. */
export const renderHeader = (shell: HTMLElement, view: HeaderView): void => {
  const set = (id: string, text: string): void => { const node = shell.querySelector(`#${id}`)!; if (node.textContent !== text) node.textContent = text; };
  set('phase', view.phase);
  set('connection', view.connection ?? '');
  (shell.querySelector('#status-sep') as HTMLElement).hidden = !view.connection;
  (shell.querySelector('#connection') as HTMLElement).hidden = !view.connection;
  set('freshness', view.updated);
  const data = { phase: view.data.phase, stale: String(view.data.stale), approval: String(view.data.approval), paused: String(view.data.paused) };
  for (const [key, value] of Object.entries(data)) if (shell.dataset[key] !== value) shell.dataset[key] = value;
};
