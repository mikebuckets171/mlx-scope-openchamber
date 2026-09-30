import { SEVERITY_WORD } from '../../present/copy.ts';
import type { DotTone, GlanceLine1, GlanceLine2, Spark, StatusSectionView } from '../../present/status.ts';
import { html, type Raw } from '../html.ts';
import { chip, chips, ICON } from './parts.ts';

// The glance component (G2): the Work Status section at 280 px and the rail's Compact mode. Line 1: phase dot · model ·
// reading · label; line 2: sparkline, chips, the view switch; line 3: the top alert. Turn stats replaces it when chosen.

const dot = (tone: DotTone): Raw => html`<span class="ws-dot" data-tone="${tone}" aria-hidden="true"></span>`;
const toggle = (expanded: boolean): Raw => html`<button class="ws-toggle" id="ws-toggle" type="button" data-action="status-toggle" aria-expanded="${String(expanded)}" aria-label="${expanded ? 'Show the glance view' : 'Show turn stats'}">${expanded ? ICON.up : ICON.down}</button>`;
const spark = (s: Spark | null, size = ''): Raw => s
  ? html`<span class="ws-spark${size ? ` ${size}` : ''}" role="img" aria-label="${s.label}"><svg viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden="true"><path class="axis" d="M0 15.5H100"/><path d="${s.path}"/></svg></span>`
  : html`<span class="ws-muted ws-grow">Chart starts after 2 readings</span>`;
const WHY_ID = 'ws-why';
const line1 = (l: GlanceLine1): Raw => l.title
  ? html`<div class="ws-line">${dot(l.dot)}<span class="${l.muted ? 'ws-muted ws-grow' : 'ws-grow'}">${l.dot === 'bad' ? html`<span class="sr-only">Critical: </span>` : ''}${l.title}</span>${l.since ? html`<span class="ws-muted">${l.since}</span>` : ''}</div>`
  : html`<div class="ws-line">${dot(l.dot)}${l.word ? html`<span>${l.word}</span>` : ''}${l.model ? html`<span class="ws-model" translate="no">${l.model}</span>` : html`<span class="ws-grow"></span>`}${l.rate ? html`<span class="ws-rate">${l.rate} <small>${l.unit}</small></span>` : ''}${chip(l.chip, l.describedBy ? WHY_ID : null)}</div>`;
const line2 = (l: GlanceLine2 | null, compact: boolean): Raw | '' => {
  if (!l) return '';
  const switcher = compact ? html`<button class="ws-btn" type="button" data-action="expand" style="margin-left:auto">Expand</button>` : toggle(false);
  switch (l.kind) {
    case 'spark': return html`<div class="ws-line">${spark(l.spark, l.size)}${l.reason ? html`<span class="ws-muted ws-grow" id="${WHY_ID}">${l.reason}</span>` : ''}${l.last ? html`<span class="ws-grow" data-basis="${l.last.basis ?? 'reported'}">Last reply <b>${l.last.rate}</b> <small>tok/s</small>${l.last.basis ? html` <small class="basis">${l.last.basis}</small>` : ''}</span>` : ''}${chips(l.chips)}${l.toggle ? switcher : ''}</div>`;
    case 'prefill': return html`<div class="ws-line"><span class="ws-rate">${l.percent} <small>of prompt read</small></span>${l.eta ? html`<span class="ws-grow" data-basis="estimate">· ${l.eta} left <small class="basis">estimate</small></span>` : html`<span class="ws-grow"></span>`}${l.toggle ? switcher : ''}</div>`;
    case 'note': return html`<div class="ws-line"><span class="ws-muted ws-grow">${l.text}</span></div>`;
    case 'armed': return html`<div class="ws-line"><span class="ws-muted ws-grow">Waiting for a message · <b>${l.left}</b> left</span><button class="ws-btn" type="button" data-action="next-cancel">Cancel</button></div>`;
    case 'measuring': return html`<div class="ws-line"><span class="pulse" aria-hidden="true"></span><span class="ws-muted ws-grow">Measuring next reply · ${l.elapsed}</span><button class="ws-btn" type="button" data-action="next-cancel">Cancel</button></div>`;
    case 'notice': return html`<div class="connection-diagnosis" data-severity="${l.severity}" role="${l.dismiss === 'tip' ? 'note' : 'status'}"><span>${l.text}${l.action ? html` · <button class="link-btn" type="button" data-action="open-scope">${l.action}</button>` : ''}</span><button class="close" type="button" data-action="dismiss-${l.dismiss}" aria-label="${l.dismiss === 'tip' ? 'Dismiss tip' : 'Dismiss'}">${ICON.close}</button></div>`;
  }
};

/** `compact`: the rail's Compact mode, which switches back with "Expand" instead of the Turn stats chevron. */
export const statusMarkup = (view: StatusSectionView, compact = false): Raw => {
  if (view.turn) {
    const t = view.turn, reasonId = t.reason ? WHY_ID : null;
    return html`<div class="ws" id="ws" data-mode="turn-stats" style="height:${view.height}px"><div class="ts-head">${dot(t.dot)}<span class="ws-rate">${t.title}</span>${t.sub ? html`<span class="ws-muted">· ${t.sub}</span>` : ''}${chip(t.chip, reasonId)}${toggle(true)}</div>
      ${t.reason ? html`<div class="ts-reason" id="${WHY_ID}">${t.reason}</div>` : ''}
      <dl class="ts-rows" id="ts-rows">${view.rows.map(row => html`<dt>${row.label}</dt><dd data-basis="${row.basis ?? 'reported'}">${row.value}${row.basis ? html`<small class="basis">${row.basis}</small>` : ''}</dd>`)}</dl>
      <div class="ws-line">${spark(t.spark, 'wide')}${chips(t.chips)}</div></div>`;
  }
  const g = view.glance!, alert = g.alert;
  return html`<div class="ws" id="ws" data-mode="${view.mode}" data-variant="${view.mode === 'non-local' ? 'nonlocal' : 'glance'}" style="height:${view.height}px">${line1(g.line1)}${line2(g.line2, compact)}${alert ? html`<div class="ws-line"><span class="ws-alert ws-grow" data-severity="${alert.severity}"><span class="sr-only">${SEVERITY_WORD[alert.severity]}: </span>${alert.text}</span>${alert.more ? html`<span class="ws-muted">+${alert.more} more</span>` : ''}</div>` : ''}</div>`;
};
