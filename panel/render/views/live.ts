import { BASIS_WORD, tip } from '../../present/parts.ts';
import { SPLASH_SPEED_HELP } from '../../present/speeds.ts';
import type { HeroBody, HeroView, LiveView, MacRow, MacView, NextView, ReplyView, Tile } from '../../present/live.ts';
import { html, flag, type Part, type Raw } from '../html.ts';
import { averagesMarkup, speedsMarkup } from './speeds.ts';
import { callouts, chip, ICON, meter, pct100, tipParts, val, type Open } from './parts.ts';

// The Live tab's markup (G2 mock): callout, hero, request tiles, This Mac. Controls carry data-action for the shell.

const P = 'live';
const chartMarkup = (body: Extract<HeroBody, { kind: 'decode' }>): Raw | string => {
  const chart = body.chart;
  if (!chart) return '';
  return html`<figure class="signal" id="signal"><div class="chart-top"><span>Last 90 seconds</span><span id="ceiling">${chart.ceiling}</span></div><div class="plot" role="img" aria-label="${chart.label}"><svg viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true"><path class="grid" d="M4 4H596 M4 60H596 M4 116H596"/><path class="trace-area" d="${chart.area}"/><path class="trace" d="${chart.line}"/>${chart.mark === null ? '' : html`<line class="mark" x1="${chart.mark}" x2="${chart.mark}" y1="4" y2="116"/>`}</svg></div><figcaption><span>−90s</span><span>${body.label === 'Recent generation speed' ? 'Recent generation speed · each reading covers up to 5 s' : 'Recent speeds'}${chart.mark === null ? '' : ' · turn start ┊'}</span><span>now</span></figcaption></figure>`;
};
const progressMarkup = (body: HeroBody | null): Raw | string => body?.kind === 'prefill'
  ? html`<section class="prefill-progress" id="prefill-progress" aria-label="Prompt progress"><div class="prefill-values"><span>Prompt progress</span><strong id="prefill-percent">${body.percent}</strong>${body.counts ? html`<span>${body.counts}</span>` : ''}</div><div class="progress-track" role="progressbar" aria-label="Prompt progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${body.fraction * 100}"><span style="width:${pct100(body.fraction)}"></span></div>${body.eta ? html`<p class="coverage-note" data-basis="estimate">About ${body.eta} left · <span class="basis">Server estimate</span></p>` : ''}</section>` : '';
const nextButton = (action: string, label: Part): Raw => html`<button class="btn quiet" type="button" data-action="${action}">${label}</button>`;
const nextCancel = nextButton('next-cancel', 'Cancel');
const nextRowBody = (next: NextView, tip: Part): Raw => {
  switch (next.kind) {
    case 'watch': return html`${nextButton('watch', `Watch ${next.runtime}`)}<span>Next reply needs this chat’s server</span>`;
    case 'armed': return html`${chip({ text: 'Next reply', attr: 'armed', outline: true })}${tip}<span><time>${next.left}</time> left</span>${nextCancel}`;
    case 'measuring': return html`<span class="pulse" aria-hidden="true"></span><span>Measuring next reply · <time>${next.elapsed}</time></span>${nextCancel}`;
    case 'result': return html`${nextButton('next-save', 'Save to Captures')}${nextButton('next-arm', 'Measure again')}`;
    default: return html`${nextButton('next-arm', html`${ICON.measure} Measure next reply`)}`;
  }
};
export const nextRow = (next: NextView | null, open: Open): Raw | string => {
  if (!next) return '';
  const t = next.kind === 'armed' ? tipParts(P, next.tip, open) : null;
  return html`<div class="next-row">${nextRowBody(next, t?.btn)}</div>${t?.pop}`;
};
const replyStrip = (reply: ReplyView | null, open: Open, prominent: boolean, currentModel: string): Raw | string => {
  if (!reply) return '';
  if (reply.empty) return '';
  const t = tipParts(P, reply.tip, open), details = reply.values.filter(v => v.unit !== 'tok/s' && v.text !== 'First token');
  const primary = reply.values.filter(v => v.unit === 'tok/s' || v.text === 'First token');
  return html`<div class="reply-strip${prominent ? ' reply-prominent' : ''}"><div class="reply-head"><span class="label">Last reply</span>${chip(reply.chip)}${t.btn}${reply.when ? html`<time>${reply.when}</time>` : ''}</div>${t.pop}${reply.model && reply.model !== currentModel ? html`<p class="reply-model" translate="no">${reply.model}</p>` : ''}<div class="reply-values">${primary.map(val)}${chip(reply.usual)}</div>${details.length || reply.split.length ? html`<details class="reading-details" id="reply-details"${flag('open', open.has('reply-details'))}><summary>Reply details</summary><div class="reply-values">${details.map(val)}</div>${reply.split.length ? html`<div class="split">${reply.split.map(val)}</div>` : ''}</details>` : ''}</div>`;
};
const hero = (h: HeroView | null, list: readonly Tile[], open: Open): Raw | string => {
  if (!h) return '';
  const a = h.attr ? tipParts(P, h.attr.tip, open) : null, c = h.context ? tipParts(P, h.context.tip, open) : null;
  const explanation = h.speeds.source === 'Splash' ? tipParts(P, tip('basis', 'How speeds are measured', SPLASH_SPEED_HELP), open)
    : h.body?.kind === 'decode' || h.body?.kind === 'prefill' ? tipParts(P, h.body.tip, open) : null;
  return html`<section class="hero-card" id="hero" aria-label="Model activity"><div class="instrument-heading"><h2>${h.speeds.phase}</h2>${h.attr ? html`<span class="title-row" id="attribution">${chip(h.attr.chip)}${a!.btn}</span>` : ''}</div>${a?.pop ?? ''}<p class="instrument-model" id="model" translate="no">${h.title}</p>${progressMarkup(h.body)}${speedsMarkup(h.speeds)}<div class="instrument-basis">${h.speeds.source} · ${h.speeds.source === 'Splash' ? 'All server activity' : 'This request'} ${explanation?.btn ?? ''}</div>${explanation?.pop ?? ''}${averagesMarkup(h.speeds)}${h.body?.kind === 'word' && h.speeds.source !== 'Splash' ? html`<p class="coverage-note">${h.body.word} · ${h.body.unit}${h.body.note ? html` · ${val(h.body.note)}` : ''}</p>` : ''}${h.body?.kind === 'paused' ? html`<p class="coverage-note" id="paused-note">${h.body.note}</p>` : ''}${h.body?.kind === 'decode' ? chartMarkup(h.body) : ''}${list.length || h.context || h.firstToken ? html`<details class="reading-details" id="request-details"${flag('open', open.has('request-details'))}><summary>Request details</summary>${h.firstToken ? html`<div class="first-token" id="first-token">${val(h.firstToken)}</div>` : ''}${h.context ? html`<div class="context-headroom" id="context-headroom"><div class="context-line"><span class="title-row">Context used ${c!.btn}</span><span data-basis="${h.context.basis}"><strong>${h.context.used}</strong>${h.context.basis !== 'reported' ? html` <small class="basis">${BASIS_WORD[h.context.basis]}</small>` : ''}</span></div>${c!.pop}${meter(h.context.fraction)}</div>` : ''}${tiles(list)}</details>` : ''}<div id="reply-strip">${h.reply && !h.reply.empty ? html`<details class="reading-details" id="last-reply"${flag('open', open.has('last-reply'))}><summary>Last reply</summary>${replyStrip(h.reply, open, false, h.title)}</details>` : ''}${nextRow(h.reply?.next ?? null, open)}</div></section>`;
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
  return html`<section class="machine" id="machine" aria-label="${mac.title}" data-stale="${String(mac.stale)}"><div class="title-row"><h2 class="machine-title">${mac.title}</h2>${t.btn}</div>${t.pop}${mac.line.length ? html`<div class="machine-line">${mac.line.map(item => html`<div><span class="machine-label">${item.label}</span><strong>${item.value}</strong>${item.meter === null ? '' : meter(item.meter)}</div>`)}</div>` : ''}${mac.rows.length ? html`<div class="mac-rows">${mac.rows.map(row => macRow(row, open))}</div>` : ''}${mac.details.length ? html`<details class="host-details" id="${detailsId}"${flag('open', open.has(detailsId))}><summary>Mac details</summary><div class="mac-rows">${mac.details.map(row => macRow(row, open))}</div></details>` : ''}</section>`;
};

const machineSummary = (mac: MacView | null): Raw | string => {
  if (!mac) return '';
  return html`<section class="machine-summary" aria-label="${mac.title}" data-stale="${String(mac.stale)}"><h2>${mac.title}</h2><div class="machine-summary-values">${mac.line.filter(item => item.label !== 'Swap').map(item => html`<span>${item.label} <strong>${item.value}</strong></span>`)}</div><div class="machine-health">${mac.rows.map(row => html`<span class="level" data-level="${row.level ?? 'normal'}">${row.key === 'pressure' ? 'Memory' : 'Heat'} ${row.value.text.toLowerCase()}</span>`)}</div></section>`;
};

export const liveMarkup = (view: LiveView, open: Open): Raw => html`${callouts(P, view.callouts, open)}${hero(view.hero, view.tiles, open)}${!view.hero ? tiles(view.tiles) : ''}${machineSummary(view.mac)}`;
