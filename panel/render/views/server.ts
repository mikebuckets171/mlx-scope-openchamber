import type { Block, ServerView } from '../../present/server.ts';
import { flag, html, type Raw } from '../html.ts';
import { callouts, chip, chips, meter, pct100, section, val, type Open } from './parts.ts';

// The Server tab's markup (G2 mock): one card per thing the runtime reports.

const P = 'server';
const block = (b: Block): Raw => {
  switch (b.kind) {
    case 'kv': return html`<dl class="kv">${b.rows.map(row => row.chips
      ? html`<div class="kv-block"><dt>${row.label}</dt><dd class="chips">${row.chips.length ? chips(row.chips) : row.value}</dd></div>`
      : html`<div><dt>${row.label}</dt><dd>${row.value}</dd></div>`)}</dl>`;
    case 'values': return html`<div class="values-${b.cols}${b.big ? ' big-values' : ''}">${b.items.map(item =>
      html`<div><span>${item.label}</span><strong>${val(item.value)}</strong>${item.small ? html`<small>${item.small}</small>` : ''}</div>`)}</div>`;
    case 'meter': return meter(b.fraction, 'margin-top:10px');
    case 'bar': return html`<div class="cache-input-bar" aria-hidden="true"><span style="width:${pct100(b.fraction)}"></span></div>`;
    case 'list': return html`<ul class="resident-list">${b.items.map(item => html`<li class="resident-row" data-loaded="${String(item.loaded)}"><div class="resident-heading"><strong translate="no">${item.title}</strong>${item.chips.length > 1 || b.chipGroup ? html`<span class="chips">${chips(item.chips)}</span>` : chip(item.chips[0] ?? null)}</div>
      ${item.reading.length ? html`<div class="resident-reading">${item.reading.map(text => html`<span>${text}</span>`)}</div>` : ''}${item.meter === null ? '' : meter(item.meter)}</li>`)}</ul>`;
  }
};
export const serverMarkup = (view: ServerView, open: Open): Raw => {
  const runtime = view.cards.find(card => card.key === 'runtime');
  return html`${callouts(P, view.callouts, open)}${view.cards.filter(card => card !== runtime).map(card =>
    section(P, card.key, card.title, card.right, card.blocks.map(block), card.tip, open))}${runtime ? html`
<details class="runtime-details" id="server-runtime-details"${flag('open', open.has('server-runtime-details'))}><summary><span>Runtime details</span><span>${runtime.right}</span></summary>
      ${section(P, runtime.key, runtime.title, '', runtime.blocks.map(block), runtime.tip, open)}</details>` : ''}`;
};
