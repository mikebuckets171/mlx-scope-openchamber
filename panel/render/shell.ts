import { DISCLOSURE_ARROW } from './disclosure.ts';
import { connectionsMarkup } from '../connections-view.ts';
import { APPROVAL, RESTART } from '../present/copy.ts';
import type { HeaderView } from '../present/header.ts';
import { html, raw, type Part, type Raw } from './html.ts';
import { ICON } from './views/parts.ts';

// The rail panel's and the page's static shell: masthead with the status pill, pause and ⋯, then one column of truth —
// This chat and its engine, then Media only while it has jobs — with History and Server & Mac details as secondary views
// reached from the column's foot, each with Back. Polls patch the pill and the visible view only.


const menuButton = (id: string, attributes: Raw, label: Part): Raw =>
  html`<button id="${id}" type="button"${attributes}><span class="menu-check" aria-hidden="true"></span>${label}</button>`;
const menu = html`<details class="monitor-menu" id="monitor-menu"><summary class="icon-btn" aria-label="More options">${ICON.more}</summary><div class="monitor-menu-content"><div id="measurement-choice"></div>${menuButton('refresh', html` disabled`, 'Refresh readings')}${menuButton('compact', html` aria-pressed="false"`, 'Compact view')}${menuButton('efficiency', html` aria-pressed="false"`, 'Energy-saving updates')}${menuButton('toasts', html` aria-describedby="toasts-state"`, html`Pop-up alerts: <span id="toasts-state">critical only</span>`)}<div id="share-actions" class="share-actions" aria-label="Share readings"></div><p class="menu-about"><span>MLX Scope <span id="scope-version"></span></span><span id="cadence">Adaptive updates</span><span>Private local monitoring · Chat delivery remains estimated</span></p></div></details>`;

/** The 3.0 shell keeps navigation quiet; the active instrument owns activity and measurement. */
export const shellMarkup = (): Raw => html`<main class="scope" id="scope" aria-labelledby="scope-title" hidden>
  <header class="masthead">
    <div class="brand"><span class="brand-mark" data-heartbeat>${ICON.mark}</span><h1 id="scope-title">MLX Scope</h1></div>
    <div class="status-pill" id="status-pill"><span class="connection-dot" aria-hidden="true"></span><span class="phase sr-only" id="phase">Connecting</span><span class="status-sep sr-only" id="status-sep" aria-hidden="true">·</span><span class="conn" id="connection" role="status">Local server</span></div>
    <div class="monitor-controls"><button class="btn quiet connections-trigger" id="connection-change" type="button" aria-expanded="false" aria-controls="connection-setup">Connections</button><button class="icon-btn" id="pause" type="button" aria-pressed="false" aria-label="Pause monitoring">${ICON.pause}</button>${menu}</div>
  </header>
  ${raw(connectionsMarkup)}
  <button id="connection-configure" type="button" hidden>Connection…</button><p id="action-status" class="action-status" role="status" hidden></p><div id="frame-card"></div>
  <div id="next-activity" class="next-activity" hidden></div><div id="capture-activity" class="next-activity" role="region" aria-label="Active timed capture" hidden></div>
  <div id="panels">
    <div class="column" id="panel-live" aria-label="This chat, engine and media" hidden><div class="view" id="view-live"></div><section class="column-block" id="view-media" aria-label="Media" hidden></section>
      <nav class="column-foot" id="column-foot" aria-label="More from Scope"><button class="btn quiet" type="button" data-action="open-history">History</button><button class="btn quiet" type="button" data-action="open-server" id="open-server">Server &amp; Mac details</button></nav></div>
    <section class="view secondary-view" id="panel-server" aria-labelledby="server-title" hidden></section>
    <section class="view secondary-view" id="panel-history" aria-labelledby="history-title" hidden><div class="secondary-heading"><button class="btn quiet" type="button" data-action="back-live">Back</button><h2 id="history-title" tabindex="-1">History</h2><button class="btn quiet secondary-action" type="button" data-action="open-captures">Captures</button></div><div class="view" id="view-history"></div></section>
    <section class="view secondary-view" id="panel-captures" aria-labelledby="captures-title" hidden><div class="secondary-heading"><button class="btn quiet" type="button" data-action="back-history">Back to History</button><h2 id="captures-title" tabindex="-1">Captures</h2></div><div id="captures-content"></div></section>
  </div>
  <div id="media-glance"></div>
  <section class="compact-glance" id="compact-glance" aria-label="MLX Scope glance" hidden></section>
  <footer><span id="freshness">No reading yet</span></footer>
</main>`;


const steps = (list: readonly string[]): Raw => html`<ol class="steps">${list.map(step => html`<li>${step}</li>`)}</ol>`;
/** Needs approval (NO_SERVICE after an update) and needs a restart (version skew): nothing else is shown. */
export const frameCardMarkup = (card: 'approval' | 'restart'): Raw => {
  const copy = card === 'approval' ? APPROVAL : RESTART;
  return html`<div class="view"><section class="approval-card" id="${card}-card" aria-labelledby="${card}-title"><h2 id="${card}-title">${copy.title}</h2><p>${copy.body}</p>${steps(copy.steps)}${card === 'approval' ? html`<details class="grant" id="grant" open><summary>What the approval lists, and why${DISCLOSURE_ARROW}</summary><dl class="kv">${APPROVAL.grant.map(([what, paths, note]) =>
      html`<div><dt>${what}</dt><dd>${paths.split(', ').map((path, index) => html`${index ? ', ' : ''}<code>${path}</code>`)}${note ? ` · ${note}` : ''}</dd></div>`)}</dl></details>` : ''}<p class="insight-note">${copy.note}</p></section></div>`;
};

/** The pill and the frame-wide data attributes the accent follows. */
export const renderHeader = (shell: HTMLElement, view: HeaderView): void => {
  const set = (id: string, text: string): void => { const node = shell.querySelector(`#${id}`)!; if (node.textContent !== text) node.textContent = text; };
  set('phase', view.phase);
  set('connection', view.connection ?? '');
  (shell.querySelector('#status-sep') as HTMLElement).hidden = !view.connection;
  (shell.querySelector('#connection') as HTMLElement).hidden = !view.connection;
  (shell.querySelector('.connection-dot') as HTMLElement).hidden = !view.connection;
  set('freshness', view.updated);
  const data = { phase: view.data.phase, stale: String(view.data.stale), approval: String(view.data.approval), paused: String(view.data.paused) };
  for (const [key, value] of Object.entries(data)) if (shell.dataset[key] !== value) shell.dataset[key] = value;
};
