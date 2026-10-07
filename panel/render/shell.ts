import { connectionsMarkup } from '../connections-view.ts';
import { APPROVAL, RESTART } from '../present/copy.ts';
import type { HeaderView } from '../present/header.ts';
import { html, raw, type Part, type Raw } from './html.ts';
import { ICON } from './views/parts.ts';
import type { PrimaryTab } from './views/types.ts';

// The rail panel's and the page's static shell (G2 mock, 1.6 structure): masthead with the status pill, pause and ⋯,
// the segmented tabs, one tabpanel per tab, and the footer. Polls patch the pill and the active panel only.

export const TABS: ReadonlyArray<readonly [PrimaryTab, string]> = [['live', 'Live'], ['history', 'History']];

const menuButton = (id: string, attributes: Raw, label: Part): Raw =>
  html`<button id="${id}" type="button"${attributes}><span class="menu-check" aria-hidden="true"></span>${label}</button>`;
const menu = html`<details class="monitor-menu" id="monitor-menu"><summary class="icon-btn" aria-label="More options">${ICON.more}</summary><div class="monitor-menu-content">${menuButton('refresh', html` disabled`, 'Refresh readings')}${menuButton('compact', html` aria-pressed="false"`, 'Compact view')}${menuButton('efficiency', html` aria-pressed="false"`, 'Energy-saving updates')}${menuButton('toasts', html` aria-describedby="toasts-state"`, html`Alert toasts: <span id="toasts-state">critical only</span>`)}<div id="share-actions" class="share-actions" aria-label="Share readings"></div>${menuButton('connection-change', html` aria-expanded="false" aria-controls="connection-setup"`, 'Connection…')}<p class="menu-about"><span id="cadence">Adaptive updates</span><span>Local · read-only · server-wide unless labelled</span></p></div></details>`;

export const shellMarkup = (): Raw => html`<main class="scope" id="scope" aria-labelledby="scope-title" hidden><header class="masthead"><div class="brand">${ICON.mark}<h1 id="scope-title">MLX <span>Scope</span></h1><span class="brand-context">OpenChamber</span></div><div class="status-pill" id="status-pill"><span class="connection-dot" aria-hidden="true"></span><span class="phase" id="phase">Connecting</span><span class="status-sep" id="status-sep" aria-hidden="true">·</span><span class="conn" id="connection" role="status">Local runtime</span></div><div class="monitor-controls"><button class="icon-btn" id="pause" type="button" aria-pressed="false" aria-label="Pause monitoring">${ICON.pause}</button>${menu}</div></header>${raw(connectionsMarkup)}<details class="connection-help" id="connection-help"><summary>Connection help</summary><p id="connection-result" role="status">Check whether OpenChamber has started the extension service. This does not change your configuration.</p><div class="insight-actions"><button id="check-connection" type="button">Check extension service</button><button id="connection-guide" type="button">Setup guide</button></div></details><button id="connection-configure" type="button" hidden>Connection…</button><p id="action-status" class="action-status" role="status" hidden></p><div id="frame-card"></div><nav class="workspace-nav" id="workspace-nav" aria-label="Scope workspaces"><div class="tablist" role="tablist" id="tablist"></div><div id="workspace-action" class="workspace-action" hidden></div></nav><div id="next-activity" class="next-activity" hidden></div><div id="capture-activity" class="next-activity" role="region" aria-label="Active timed capture" hidden></div><div id="panels"><div role="tabpanel" id="panel-live" aria-labelledby="tab-live" tabindex="0" hidden><div class="view" id="view-live"></div><section class="view secondary-view" id="panel-server" aria-labelledby="server-title" hidden></section></div><div role="tabpanel" id="panel-history" aria-labelledby="tab-history" tabindex="0" hidden><div class="view" id="view-history"></div><section class="view secondary-view" id="panel-captures" aria-labelledby="captures-title" hidden><div class="secondary-heading"><button class="btn quiet" type="button" data-action="back-history">Back to History</button><h2 id="captures-title" tabindex="-1">Captures</h2></div><div id="captures-content"></div></section></div></div><section class="compact-glance" id="compact-glance" aria-label="MLX Scope glance" hidden></section><footer><span>MLX Scope <span id="scope-version"></span></span><span id="freshness">No reading yet</span></footer></main>`;

export const tabsMarkup = (tabs: ReadonlyArray<readonly [PrimaryTab, string]>, active: PrimaryTab): Raw => html`${tabs.map(([id, label]) =>
  html`<button class="tab" role="tab" type="button" id="tab-${id}" data-tab="${id}" aria-controls="panel-${id}" aria-selected="${String(id === active)}" tabindex="${id === active ? 0 : -1}">${label}</button>`)}`;

const steps = (list: readonly string[]): Raw => html`<ol class="steps">${list.map(step => html`<li>${step}</li>`)}</ol>`;
/** Needs approval (NO_SERVICE after an update) and needs a restart (version skew): nothing else is shown. */
export const frameCardMarkup = (card: 'approval' | 'restart'): Raw => {
  const copy = card === 'approval' ? APPROVAL : RESTART;
  return html`<div class="view"><section class="approval-card" id="${card}-card" aria-labelledby="${card}-title"><h2 id="${card}-title">${copy.title}</h2><p>${copy.body}</p>${steps(copy.steps)}${card === 'approval' ? html`<details class="grant" id="grant" open><summary>What the approval lists, and why</summary><dl class="kv">${APPROVAL.grant.map(([what, paths, note]) =>
      html`<div><dt>${what}</dt><dd>${paths.split(', ').map((path, index) => html`${index ? ', ' : ''}<code>${path}</code>`)}${note ? ` · ${note}` : ''}</dd></div>`)}</dl></details>` : ''}<p class="insight-note">${copy.note}</p></section></div>`;
};

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
