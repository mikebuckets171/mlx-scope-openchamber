import { BASIS_WORD } from '../../present/parts.ts';
import { SEVERITY_WORD } from '../../present/copy.ts';
import type { DotTone, GlanceLine1, GlanceLine2, GlanceNotice, Spark, StatusSectionView } from '../../present/status.ts';
import { html, type Raw } from '../html.ts';
import { chip, chips, ICON } from './parts.ts';

// The glance component (G2): the Work Status section at 280 px and the rail's Compact mode. Line 1: phase dot · model ·
// reading · label; line 2: sparkline, chips, the view switch; line 3: the top alert. Turn stats replaces it when chosen.

const dot = (tone: DotTone): Raw => html`<span class="ws-dot" data-tone="${tone}" aria-hidden="true"></span>`;
const toggle = (expanded: boolean): Raw => html`<button class="ws-toggle" id="ws-toggle" type="button" data-action="status-toggle" aria-expanded="${String(expanded)}" aria-label="${expanded ? 'Show the glance view' : 'Show turn stats'}">${expanded ? ICON.up : ICON.down}</button>`;
/** Fewer than 2 readings: no chart. The line says so only when nothing more useful needs the room. */
const spark = (s: Spark | null, size = ''): Raw | '' => s
  ? html`<span class="ws-spark${size ? ` ${size}` : ''}" role="img" aria-label="${s.label}"><svg viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden="true"><path class="axis" d="M0 15.5H100"/><path d="${s.path}"/></svg></span>`
  : '';
const WHY_ID = 'ws-why';
const line1 = (l: GlanceLine1, switcher: Raw | '' = ''): Raw => l.title
  ? html`<div class="ws-line">${dot(l.dot)}<span class="${l.muted ? 'ws-muted ws-grow' : 'ws-grow'}">${l.dot === 'bad' ? html`<span class="sr-only">Critical: </span>` : ''}${l.title}</span>${l.since ? html`<span class="ws-muted">${l.since}</span>` : ''}</div>`
  : html`<div class="ws-line ws-heading">${dot(l.dot)}<span class="ws-phase">${l.word ?? (l.dot === 'prefill' ? 'Reading prompt' : l.rate ? 'Generating' : 'Working')}</span><span class="ws-grow"></span>${l.rate ? html`<span class="ws-rate" data-basis="${l.rateBasis}">${l.rate} <small>${l.unit}</small>${l.rateBasis !== 'reported' ? html` <small class="basis">${BASIS_WORD[l.rateBasis]}</small>` : ''}</span>` : ''}${!l.model ? chip(l.chip, l.describedBy ? WHY_ID : null) : ''}${switcher}</div>${l.model ? html`<div class="ws-line ws-model-line"><span class="ws-model" translate="no">${l.model}</span>${chip(l.chip, l.describedBy ? WHY_ID : null)}</div>${l.since ? html`<div class="ws-age">${l.since}</div>` : ''}` : ''}`;
const line2 = (l: GlanceLine2 | null, compact: boolean): Raw | '' => {
  if (!l) return '';
  const switcher = compact ? html`<button class="ws-btn" type="button" data-action="expand" style="margin-left:auto">Expand</button>` : '';
  switch (l.kind) {
    case 'spark': return html`<div class="ws-line">${spark(l.spark, l.size)}${l.reason ? html`<span class="ws-muted ws-grow" id="${WHY_ID}">${l.reason}</span>` : ''}${l.last ? html`<span class="ws-grow" data-basis="${l.last.basis ?? 'reported'}">Last reply <b>${l.last.rate}</b> <small>tok/s</small>${l.last.basis ? html` <small class="basis">${l.last.basis}</small>` : ''}</span>` : ''}${chips(l.chips)}${l.toggle ? switcher : ''}</div>`;
    case 'prefill': return html`<div class="ws-line"><span class="ws-rate">${l.percent} <small>of prompt read</small></span>${l.eta ? html`<span class="ws-grow" data-basis="estimate">· ${l.eta} left <small class="basis">estimate</small></span>` : html`<span class="ws-grow"></span>`}${l.toggle ? switcher : ''}</div>`;
    case 'note': return html`<div class="ws-line"><span class="ws-muted ws-grow">${l.text}</span></div>`;
    case 'armed': return html`<div class="ws-line"><span class="ws-muted ws-grow">Waiting for a message · <b>${l.left}</b> left</span><button class="ws-btn" type="button" data-action="next-cancel">Cancel</button></div>`;
    case 'measuring': return html`<div class="ws-line"><span class="pulse" aria-hidden="true"></span><span class="ws-muted ws-grow">Measuring next reply · ${l.elapsed}</span><button class="ws-btn" type="button" data-action="next-cancel">Cancel</button></div>`;
  }
};

const notice = (n: GlanceNotice | null): Raw | '' => n ? html`<div class="connection-diagnosis" data-severity="info" role="${n.dismiss === 'tip' ? 'note' : 'status'}"><span>${n.text}${n.action ? ` · ${n.action}` : ''}</span><button class="close" type="button" data-action="dismiss-${n.dismiss}" aria-label="${n.dismiss === 'tip' ? 'Dismiss tip' : 'Dismiss'}">${ICON.close}</button></div>` : '';

/** The Session pane gives the model its own row and separates any alert; Compact keeps its original height. */
export const statusHeight = (view: StatusSectionView, compact = false): number => Math.min(compact ? 160 : 200, view.height + (view.glance?.line1.model ? 24 : 0) + (!compact && view.glance?.alert ? 8 : 0) + (compact ? 0 : (view.glance?.metrics?.length ?? 0) * 20) + (view.glance?.line1.since && view.glance.line1.model ? 16 : 0));
const alertRow = (alert: NonNullable<NonNullable<StatusSectionView['glance']>['alert']>, compact: boolean): Raw => {
  const pressure = !compact && alert.text.startsWith('macOS memory pressure:');
  return html`<div class="ws-line${compact ? '' : ' ws-alert-row'}"><span class="ws-alert ws-grow" data-severity="${alert.severity}">${pressure ? html`<span class="sr-only">macOS memory pressure: ${alert.severity}</span><span aria-hidden="true">Memory pressure</span>` : html`<span class="sr-only">${SEVERITY_WORD[alert.severity]}: </span>${alert.text}`}</span>${pressure ? html`<span class="ws-severity" data-severity="${alert.severity}" aria-hidden="true">${SEVERITY_WORD[alert.severity]}</span>` : ''}${alert.more ? html`<span class="ws-muted">+${alert.more} more</span>` : ''}</div>`;
};

/** `compact`: the rail's Compact mode, which switches back with "Expand" instead of the Turn stats chevron. */
export const statusMarkup = (view: StatusSectionView, compact = false): Raw => {
  if (view.turn) {
    const t = view.turn, reasonId = t.reason ? WHY_ID : null;
    return html`<div class="ws" id="ws" data-mode="turn-stats" style="height:${view.height}px"><div class="ts-head">${dot(t.dot)}<span class="ws-rate">${t.title}</span>${t.sub ? html`<span class="ws-muted">· ${t.sub}</span>` : ''}${chip(t.chip, reasonId)}${toggle(true)}</div>${t.reason ? html`<div class="ts-reason" id="${WHY_ID}">${t.reason}</div>` : ''}<dl class="ts-rows" id="ts-rows">${view.rows.map(row => html`<dt>${row.label}</dt><dd data-basis="${row.basis ?? 'reported'}">${row.value}${row.basis ? html`<small class="basis">${row.basis}</small>` : ''}</dd>`)}</dl>${t.alert ? alertRow(t.alert, false) : html`<div class="ws-line">${spark(t.spark, 'wide')}${chips(t.chips)}</div>`}</div>`;
  }
  const g = view.glance!, alert = g.alert;
  const switcher = !compact && g.line2 && 'toggle' in g.line2 && g.line2.toggle ? toggle(false) : '';
  return html`<div class="ws" id="ws" data-presentation="${compact ? 'compact' : 'session'}" data-mode="${view.mode}" data-variant="${view.mode === 'non-local' ? 'nonlocal' : 'glance'}" style="height:${statusHeight(view, compact)}px">${line1(g.line1, switcher)}${!compact && g.metrics?.length ? html`<dl class="ws-key-stats">${g.metrics.map(row => html`<dt>${row.label}</dt><dd data-basis="${row.basis ?? 'reported'}">${row.value}${row.basis ? html` <small class="basis">${row.basis}</small>` : ''}</dd>`)}</dl>` : ''}${line2(g.line2, compact)}${notice(compact ? null : g.notice)}${alert ? alertRow(alert, compact) : ''}</div>`;
};

/** Only the rail's Compact view ships this renderer; Session has its own summary. */
export const compactMarkup = (view: StatusSectionView): Raw => {
  const g = view.glance!;
  return html`<div class="ws" id="ws" data-presentation="compact" data-mode="${view.mode}" data-variant="${view.mode === 'non-local' ? 'nonlocal' : 'glance'}" style="height:${statusHeight(view, true)}px">${line1(g.line1)}${line2(g.line2, true)}${g.alert ? alertRow(g.alert, true) : ''}</div>`;
};
