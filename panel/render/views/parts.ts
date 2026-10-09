import { SEVERITY_WORD } from '../../present/copy.ts';
import { basisNote, type Callout, type Chip, type Tip, type Val } from '../../present/parts.ts';
import { flag, html, type Part, type Raw } from '../html.ts';

// Markup for the view-model parts every 2.0 view shares (the G2 mock's classes). Disclosures are stable per key, so a
// poll re-renders them in the state the reader left them.

// Remix Icon 4.6.0: the same 24 px glyphs shipped by OpenChamber 2.2.0. Apache-2.0 notices are bundled.
export const ICON_PATH = {
  measure: 'M17.6177 5.9681L19.0711 4.51472L20.4853 5.92893L19.0319 7.38231C20.2635 8.92199 21 10.875 21 13C21 17.9706 16.9706 22 12 22C7.02944 22 3 17.9706 3 13C3 8.02944 7.02944 4 12 4C14.125 4 16.078 4.73647 17.6177 5.9681ZM12 20C15.866 20 19 16.866 19 13C19 9.13401 15.866 6 12 6C8.13401 6 5 9.13401 5 13C5 16.866 8.13401 20 12 20ZM11 8H13V14H11V8ZM8 1H16V3H8V1Z',
  close: 'M11.9997 10.5865L16.9495 5.63672L18.3637 7.05093L13.4139 12.0007L18.3637 16.9504L16.9495 18.3646L11.9997 13.4149L7.04996 18.3646L5.63574 16.9504L10.5855 12.0007L5.63574 7.05093L7.04996 5.63672L11.9997 10.5865Z',
  down: 'M11.9999 13.1714L16.9497 8.22168L18.3639 9.63589L11.9999 15.9999L5.63599 9.63589L7.0502 8.22168L11.9999 13.1714Z',
  up: 'M11.9999 10.8284L7.0502 15.7782L5.63599 14.364L11.9999 8L18.3639 14.364L16.9497 15.7782L11.9999 10.8284Z',
  right: 'M13.1717 12.0007L8.22192 7.05093L9.63614 5.63672L16.0001 12.0007L9.63614 18.3646L8.22192 16.9504L13.1717 12.0007Z',
  pause: 'M6 5H8V19H6V5ZM16 5H18V19H16V5Z',
  play: 'M16.3944 12.0001L10 7.7371V16.263L16.3944 12.0001ZM19.376 12.4161L8.77735 19.4818C8.54759 19.635 8.23715 19.5729 8.08397 19.3432C8.02922 19.261 8 19.1645 8 19.0658V4.93433C8 4.65818 8.22386 4.43433 8.5 4.43433C8.59871 4.43433 8.69522 4.46355 8.77735 4.5183L19.376 11.584C19.6057 11.7372 19.6678 12.0477 19.5146 12.2774C19.478 12.3323 19.4309 12.3795 19.376 12.4161Z',
  more: 'M4.5 10.5C3.675 10.5 3 11.175 3 12C3 12.825 3.675 13.5 4.5 13.5C5.325 13.5 6 12.825 6 12C6 11.175 5.325 10.5 4.5 10.5ZM19.5 10.5C18.675 10.5 18 11.175 18 12C18 12.825 18.675 13.5 19.5 13.5C20.325 13.5 21 12.825 21 12C21 11.175 20.325 10.5 19.5 10.5ZM12 10.5C11.175 10.5 10.5 11.175 10.5 12C10.5 12.825 11.175 13.5 12 13.5C12.825 13.5 13.5 12.825 13.5 12C13.5 11.175 12.825 10.5 12 10.5Z',
  mark: 'M9 7.53861L15 21.5386L18.6594 13H23V11H17.3406L15 16.4614L9 2.46143L5.3406 11H1V13H6.6594L9 7.53861Z',
  info: 'M12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22ZM12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20ZM11 7H13V9H11V7ZM11 11H13V17H11V11Z',
} as const;
const icon = (path: string, className = ''): Raw =>
  html`<svg class="scope-icon${className ? ` ${className}` : ''}" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
export const ICON = {
  measure: icon(ICON_PATH.measure),
  right: icon(ICON_PATH.right),
  pause: icon(ICON_PATH.pause),
  play: icon(ICON_PATH.play),
  more: icon(ICON_PATH.more),
  mark: icon(ICON_PATH.mark, 'scope-mark'),
  info: icon(ICON_PATH.info),
} as const;
/** Legacy Turn-stats markup constructs its glyphs only when that unbundled renderer is used. */
export const legacyIcon = (name: 'close' | 'down' | 'up'): Raw => icon(ICON_PATH[name]);

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
  html`<button class="info" type="button" data-disclose="info" aria-expanded="${String(open.has(id))}" aria-controls="${id}" aria-label="About ${t.title}">${ICON.info}</button>`;
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
  return html`<div class="connection-diagnosis" data-severity="${top!.severity}" role="status" data-key="callout-${prefix}">${calloutBody(top!)}${rest.length ? html`<button class="link-btn" type="button" data-disclose="more" aria-expanded="${String(open.has(id))}" aria-controls="${id}">${rest.length} more ${rest.length === 1 ? 'alert' : 'alerts'}</button><ul class="diag-more" id="${id}"${flag('hidden', !open.has(id))}>${rest.map(item => html`<li>${calloutBody(item)}</li>`)}</ul>` : ''}</div>`;
};
export const section = (prefix: string, key: string, title: string, right: Part, body: Part, t: Tip | null, open: Open, extra = ''): Raw => {
  const { btn, pop } = tipParts(prefix, t, open);
  return html`<section class="insight-section${extra}" data-key="${prefix}-${key}"><div class="section-heading"><div class="title-row"><h2>${title}</h2>${btn}</div>${right ? html`<span>${right}</span>` : ''}</div>${pop}${body}</section>`;
};
export const meter = (fraction: number, style = ''): Raw => html`<div class="meter" aria-hidden="true"${style ? html` style="${style}"` : ''}><i style="width:${pct100(fraction)}"></i></div>`;
