import type { HeroBody, HeroView, LiveView, MacRow, MacView, NextView, ReplyView, Tile } from '../../present/live.ts';
import { html, flag, type Raw } from '../html.ts';
import { callouts, chip, ICON, meter, pct100, tipParts, val, type Open } from './parts.ts';

// The Live tab's markup (G2 mock): callout, hero, request tiles, This Mac. Controls carry data-action for the shell.

const P = 'live';
const chartMarkup = (body: Extract<HeroBody, { kind: 'decode' }>): Raw | string => {
  const chart = body.chart;
  if (!chart) return html`<p class="chart-wait" id="chart-wait">The chart starts after 2 readings.</p>`;
  return html`<figure class="signal" id="signal"><div class="chart-top"><span>${chart.title}</span><span id="ceiling">${chart.ceiling}</span></div>
    <div class="plot" role="img" aria-label="${chart.label}"><svg viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true"><path class="grid" d="M4 4H596 M4 60H596 M4 116H596"/>
    <path class="trace-area" d="${chart.area}"/><path class="trace" d="${chart.line}"/>${chart.mark === null ? '' : html`<line class="mark" x1="${chart.mark}" x2="${chart.mark}" y1="4" y2="116"/>`}</svg></div>
    <figcaption><span>−90s</span><span>Live observations${chart.mark === null ? '' : ' · turn start ┊'}</span><span>now</span></figcaption></figure>`;
};
const heroBody = (body: HeroBody | null, open: Open): Raw | string => {
  if (!body) return '';
  switch (body.kind) {
    case 'paused': return html`<p class="coverage-note" id="paused-note">${body.note}</p>`;
    case 'prefill': {
      const t = tipParts(P, body.tip, open);
      return html`<section class="prefill-progress" id="prefill-progress" aria-label="Prefill progress">
        <div class="prefill-values"><strong class="prefill-remaining" id="prefill-percent" data-basis="reported">${body.percent}</strong>${body.counts ? html`<span class="prefill-completed">${body.counts}</span>` : ''}</div>
        <div class="progress-track" role="progressbar" aria-label="Prefill progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(body.fraction * 100)}"><span style="width:${pct100(body.fraction)}"></span></div>
        ${body.eta ? html`<div class="prefill-estimate" data-basis="estimate"><span>Prefill finishes in about</span><strong>${body.eta}</strong><small class="basis">Runtime estimate · may change</small></div>` : ''}</section>
        ${body.rate ? html`<div class="hero-row"><div class="readout"><span class="rate" id="rate" data-basis="reported">${body.rate}</span><span class="unit">tokens / second · reading context<br><span class="basis-line">${body.source} ${t.btn}</span></span></div>${t.pop}</div>` : ''}`;
    }
    case 'decode': {
      const t = tipParts(P, body.tip, open);
      return html`<div class="hero-row"><div class="readout"><span class="rate" id="rate" data-basis="reported">${body.rate}</span><span class="unit">tokens / second · request average<br><span class="basis-line">${body.source} ${t.btn}</span></span></div>${t.pop}
        ${chartMarkup(body)}</div>`;
    }
    default: return html`<div class="hero-row"><div class="readout"><span class="rate is-word" id="rate">${body.word}</span><span class="unit">${body.unit}</span></div></div>
      ${body.note ? html`<p class="coverage-note">${val(body.note)}</p>` : ''}`;
  }
};
const nextRow = (next: NextView | null, open: Open): Raw | string => {
  if (!next) return '';
  switch (next.kind) {
    case 'watch': return html`<div class="next-row"><button class="btn quiet" type="button" data-action="connection">Watch ${next.runtime}</button><span>Next reply needs this chat’s runtime</span></div>`;
    case 'armed': { const t = tipParts(P, next.tip, open);
      return html`<div class="next-row">${chip({ text: 'Next reply · armed', attr: 'armed', outline: true })}${t.btn}<span><time>${next.left}</time> left</span><button class="btn quiet" type="button" data-action="next-cancel">Cancel</button></div>${t.pop}`; }
    case 'measuring': return html`<div class="next-row"><span class="pulse" aria-hidden="true"></span><span>Measuring next reply · <time>${next.elapsed}</time></span><button class="btn quiet" type="button" data-action="next-cancel">Cancel</button></div>`;
    case 'result': return html`<div class="next-row"><button class="btn quiet" type="button" data-action="next-save">Save to Captures</button><button class="btn quiet" type="button" data-action="next-arm">Measure again</button></div>`;
    default: return html`<div class="next-row"><button class="btn quiet" type="button" data-action="next-arm">${ICON.measure} Measure next reply</button><span>One reply in this chat · arms for 2 min</span></div>`;
  }
};
const replyStrip = (reply: ReplyView | null, open: Open): Raw | string => {
  if (!reply) return '';
  if (reply.empty) return html`<div class="reply-strip" id="reply-strip"><div class="reply-head"><span class="label">Last reply</span><span>${reply.empty}</span></div>${nextRow(reply.next, open)}</div>`;
  const t = tipParts(P, reply.tip, open);
  return html`<div class="reply-strip" id="reply-strip"><div class="reply-head"><span class="label">Last reply</span>${chip(reply.chip)}${t.btn}${reply.when ? html`<time>${reply.when}</time>` : ''}</div>${t.pop}
    <div class="reply-values">${reply.values.map(val)}${chip(reply.usual)}</div>${reply.split.length ? html`<div class="split">${reply.split.map(val)}</div>` : ''}${nextRow(reply.next, open)}</div>`;
};
const hero = (h: HeroView | null, open: Open): Raw | string => {
  if (!h) return '';
  const a = h.attr ? tipParts(P, h.attr.tip, open) : null, c = h.context ? tipParts(P, h.context.tip, open) : null;
  return html`<section class="hero-card" id="hero" aria-label="Inference activity"><div class="hero-top"><h2 class="model-name" id="model" translate="no"><span>${h.title}</span></h2>${h.attr ? html`<span class="title-row" id="attribution">${chip(h.attr.chip)}${a!.btn}</span>` : ''}</div>${a?.pop ?? ''}
    ${heroBody(h.body, open)}${h.context ? html`<div class="context-headroom" id="context-headroom"><div class="context-line"><span class="title-row">Context used ${c!.btn}</span><span><strong>${h.context.used}</strong><small class="ctx-extra"> · prompt + output</small></span></div>${c!.pop}
      ${meter(h.context.fraction)}</div>` : ''}${replyStrip(h.reply, open)}</section>`;
};
const tiles = (list: readonly Tile[]): Raw | string => list.length ? html`<div class="metrics" id="metrics" data-count="${list.length}" aria-label="Current request">${list.map(tile =>
  html`<div><span class="metric-label">${tile.label}</span><strong data-basis="reported">${tile.value}</strong><span class="metric-detail">${tile.detail}</span>${tile.meter === null ? '' : meter(tile.meter)}</div>`)}</div>` : '';
const macRow = (row: MacRow, open: Open): Raw => {
  const t = tipParts(P, row.tip, open);
  return html`<div class="mac-row" data-key="mac-${row.key}"><span${t.btn ? html` class="title-row"` : ''}>${row.label}${t.btn ? ' ' : ''}${t.btn}</span>${row.level ? html`<strong class="level" data-level="${row.level}">${row.value.text}</strong>` : val(row.value)}${row.meter === null ? '' : meter(row.meter)}${t.pop}</div>`;
};
export const macCard = (mac: MacView | null, open: Open): Raw | string => {
  if (!mac) return '';
  const t = tipParts(P, mac.tip, open), detailsId = 'mac-details';
  return html`<section class="machine" id="machine" aria-label="${mac.title}" data-stale="${String(mac.stale)}"><div class="title-row"><h2 class="machine-title">${mac.title}</h2>${t.btn}</div>${t.pop}
    ${mac.line.length ? html`<div class="machine-line">${mac.line.map(item => html`<div><span class="machine-label">${item.label}</span><strong>${item.value}</strong>${item.meter === null ? '' : meter(item.meter)}</div>`)}</div>` : ''}
    ${mac.rows.length ? html`<div class="mac-rows">${mac.rows.map(row => macRow(row, open))}</div>` : ''}
    ${mac.details.length ? html`<details class="host-details" id="${detailsId}"${flag('open', open.has(detailsId))}><summary>Mac details</summary><div class="mac-rows">${mac.details.map(row => macRow(row, open))}</div></details>` : ''}</section>`;
};

export const liveMarkup = (view: LiveView, open: Open): Raw => html`${callouts(P, view.callouts, open)}${hero(view.hero, open)}${tiles(view.tiles)}${macCard(view.mac, open)}`;
