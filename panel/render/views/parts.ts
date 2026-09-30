import { SEVERITY_WORD } from '../../present/copy.ts';
import { basisNote, type Callout, type Chip, type Tip, type Val } from '../../present/parts.ts';
import { flag, html, raw, type Part, type Raw } from '../html.ts';

// Markup for the view-model parts every 2.0 view shares (the G2 mock's classes). Disclosures are stable per key, so a
// poll re-renders them in the state the reader left them.

export const ICON = {
  measure: raw('<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.6"/></svg>'),
  close: raw('<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>'),
  down: raw('<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>'),
  up: raw('<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg>'),
  pause: raw('<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5v10M13 5v10"/></svg>'),
  play: raw('<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5l8 5-8 5z"/></svg>'),
  more: raw('<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4.5" cy="10" r="1.3"/><circle cx="10" cy="10" r="1.3"/><circle cx="15.5" cy="10" r="1.3"/></svg>'),
  mark: raw('<svg class="scope-mark" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="11"/><path d="M3 14h6l3-5 4 10 3-5h6"/></svg>'),
} as const;

/** Which disclosures are open, by element id; the one place a view reads it. */
export type Open = ReadonlySet<string>;
export const pct100 = (fraction: number): string => `${Math.max(0, Math.min(100, fraction * 100)).toFixed(1)}%`;

export const val = (v: Val): Raw => {
  const note = basisNote(v.basis, v.note);
  return html`<span class="val" data-basis="${v.basis}">${v.text ? `${v.text}${v.strong || v.unit ? ' ' : ''}` : ''}${v.strong ? html`<strong>${v.strong}</strong>` : ''}${v.unit ? ` ${v.unit}` : ''}${note ? html`<small class="basis">${note}</small>` : ''}</span>`;
};
export const chip = (c: Chip | null, describedBy: string | null = null): Raw | '' => c ? html`<span class="chip"${c.tone ? html` data-tone="${c.tone}"` : ''}${flag('data-outline', c.outline === true)}${c.attr ? html` data-attr="${c.attr}"` : ''}${c.reason ? html` data-reason="${c.reason}"` : ''}${c.basis ? html` data-basis="${c.basis}"` : ''}${describedBy ? html` aria-describedby="${describedBy}"` : ''}>${c.text}</span>` : '';
export const chips = (list: readonly Chip[]): Raw => html`${list.map(item => chip(item))}`;

/** An ⓘ: a 24 px disclosure button, and its explanation, which opens in flow under its row. */
export const tipButton = (id: string, t: Tip, open: Open): Raw =>
  html`<button class="info" type="button" data-disclose="info" aria-expanded="${String(open.has(id))}" aria-controls="${id}" aria-label="About ${t.title}">i</button>`;
export const tipPop = (id: string, t: Tip, open: Open): Raw =>
  html`<div class="pop" id="${id}" role="note"${flag('hidden', !open.has(id))}><strong>${t.title}</strong>${t.paras.map(p => html`<p>${p}</p>`)}</div>`;
export const tipParts = (prefix: string, t: Tip | null, open: Open): { btn: Raw | ''; pop: Raw | '' } => {
  if (!t) return { btn: '', pop: '' };
  const id = `pop-${prefix}-${t.key}`;
  return { btn: tipButton(id, t, open), pop: tipPop(id, t, open) };
};

const calloutBody = (c: Callout): Raw => html`<p class="diag-title"><span class="sr-only">${SEVERITY_WORD[c.severity]}: </span><strong>${c.title}</strong>${c.since ? html`<span class="diag-meta">${c.since}</span>` : ''}</p>${c.detail ? html`<p class="diag-meta">${c.detail}</p>` : ''}${c.action ? html`<button class="link-btn" type="button" data-action="${c.action.kind}">${c.action.label}</button>` : ''}`;
/** The one callout: the most severe message; the rest behind "N more". */
export const callouts = (prefix: string, list: readonly Callout[], open: Open): Raw | '' => {
  if (!list.length) return '';
  const [top, ...rest] = list, id = `more-${prefix}`;
  return html`<div class="connection-diagnosis" data-severity="${top!.severity}" role="status" data-key="callout-${prefix}">${calloutBody(top!)}${rest.length ? html`
    <button class="link-btn" type="button" data-disclose="more" aria-expanded="${String(open.has(id))}" aria-controls="${id}">${rest.length} more ${rest.length === 1 ? 'alert' : 'alerts'}</button>
    <ul class="diag-more" id="${id}"${flag('hidden', !open.has(id))}>${rest.map(item => html`<li>${calloutBody(item)}</li>`)}</ul>` : ''}</div>`;
};
export const section = (prefix: string, key: string, title: string, right: Part, body: Part, t: Tip | null, open: Open, extra = ''): Raw => {
  const { btn, pop } = tipParts(prefix, t, open);
  return html`<section class="insight-section${extra}" data-key="${prefix}-${key}"><div class="section-heading"><div class="title-row"><h2>${title}</h2>${btn}</div>${right ? html`<span>${right}</span>` : ''}</div>${pop}${body}</section>`;
};
export const meter = (fraction: number, style = ''): Raw => html`<div class="meter" aria-hidden="true"${style ? html` style="${style}"` : ''}><i style="width:${pct100(fraction)}"></i></div>`;
