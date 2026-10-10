import { digitMarkup } from '../digit-roll.ts';
import { DISCLOSURE_ARROW } from '../disclosure.ts';
import { BASIS_WORD, tip } from '../../present/parts.ts';
import { dur, kt } from '../../present/format.ts';
import { SPLASH_SPEED_HELP } from '../../present/speeds.ts';
import type { HeroView, LiveView, MacRow, MacView, NextView, ReplyView, Tile } from '../../present/live.ts';
import type { ChartView } from '../chart.ts';
import { html, flag, type Part, type Raw } from '../html.ts';
import { averagesMarkup, compactRate, speedsMarkup } from './speeds.ts';
import { READOUT_ID, scopeMenuMarkup } from './session.ts';
import { callouts, chip, ICON, meter, pct100, tipParts, val, type Open } from './parts.ts';

// Activity, speed and available engine context share one flat instrument.

const P = 'live';
const chartMarkup = (chart: ChartView): Raw => html`<figure class="signal" id="signal"><div class="chart-top"><span>Engine trend · 90 seconds</span><span id="ceiling">${chart.ceiling}</span></div><div class="plot" role="img" aria-label="${chart.label}"><svg viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true"><path class="grid" d="M4 4H596 M4 60H596 M4 116H596"/><path class="trace-area" d="${chart.area}"/><path class="trace" d="${chart.line}"/>${chart.mark === null ? '' : html`<line class="mark" x1="${chart.mark}" x2="${chart.mark}" y1="4" y2="116"/>`}</svg></div><figcaption><span>−90s</span><span>${chart.title.startsWith('Recent generation speed') ? 'Each reading covers up to 5 s' : 'Recent generation speed'}${chart.mark === null ? '' : ' · turn start ┊'}</span><span>now</span></figcaption></figure>`;
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
const replyStrip = (reply: ReplyView | null, open: Open, currentModel: string): Raw | string => {
  if (!reply) return '';
  if (reply.empty) return '';
  const t = tipParts(P, reply.tip, open), details = reply.values.filter(v => v.unit !== 'tok/s' && v.text !== 'First token');
  const primary = reply.values.filter(v => v.unit === 'tok/s' || v.text === 'First token');
  return html`<div class="reply-strip"><div class="reply-head"><span class="label">Last reply</span>${chip(reply.chip)}${t.btn}${reply.when ? html`<time>${reply.when}</time>` : ''}</div>${t.pop}${reply.model && reply.model !== currentModel ? html`<p class="reply-model" translate="no">${reply.model}</p>` : ''}<div class="reply-values">${primary.map(val)}${chip(reply.usual)}</div>${details.length || reply.split.length ? html`<details class="reading-details" id="reply-details"${flag('open', open.has('reply-details'))}><summary>Reply details${DISCLOSURE_ARROW}</summary><div class="reply-values">${details.map(val)}</div>${reply.split.length ? html`<div class="split">${reply.split.map(val)}</div>` : ''}</details>` : ''}</div>`;
};
const hero = (h: HeroView | null, list: readonly Tile[], open: Open, mac: MacView | null): Raw | string => {
  if (!h) return '';
  const a = h.attr ? tipParts(P, h.attr.tip, open) : null, c = h.context ? tipParts(P, h.context.tip, open) : null;
  const instrument = h.instrument, reading = instrument.measurement;
  const explanation = h.speeds.source === 'Splash' ? tipParts(P, tip('basis', 'How engine speeds are measured', SPLASH_SPEED_HELP), open)
    : h.body?.kind === 'decode' || h.body?.kind === 'prefill' ? tipParts(P, h.body.tip, open) : null;
  const measurementTip = reading ? tipParts(P, tip('measurement', reading.label, [reading.detail]), open) : null;
  const prefill = reading?.kind === 'progress' && h.body?.kind === 'prefill' ? h.body : null;
  const result = reading?.result;
  const fallback = list.filter(tile => ['Active requests', 'Model memory', 'Metal allocations', 'Median first token'].includes(tile.label));
  const facts: Tile[] = result ? ([
    ['Output', result.outputTokens, kt, 'reported'],
    [result.timing === 'step' ? 'Step duration' : 'Duration', result.durationMs, dur, 'derived'],
    ['First token', result.ttftMs, dur, reading!.basis],
  ] as const).flatMap(([label, value, format, basis]) => value == null ? [] : [{ label, value: format(value), detail: label === 'Output' ? 'tokens' : '', meter: null, basis }]) : fallback.length ? fallback.slice(0, 3) : reading?.live && !prefill ? list.filter(tile => tile.label === 'Output' || tile.label === 'Elapsed' && reading.kind !== 'elapsed') : [];
  if (reading?.live && !prefill && h.firstToken && facts.length < 3) facts.push({ label: 'First token', value: h.firstToken.strong!, detail: '', meter: null, basis: h.firstToken.basis });
  const quiet = !reading && !facts.length && (instrument.phase === 'Ready' || instrument.phase === 'Idle');
  const remaining = list.filter(tile => !facts.includes(tile));
  const notes = html`${instrument.note && !instrument.alert ? html`<p class="coverage-note">${instrument.note}</p>` : ''}${h.body?.kind === 'word' && !reading && h.speeds.source !== 'Splash' ? html`<p class="coverage-note">${h.body.unit}${h.body.note ? html` · ${val(h.body.note)}` : ''}</p>` : ''}${h.body?.kind === 'paused' ? html`<p class="coverage-note" id="paused-note">${h.body.note}</p>` : ''}`;
  return html`<section class="hero-card" id="hero" aria-label="Activity and speed" data-arrive>
    <div class="instrument-heading"><h2 class="instrument-phase" data-tone="${instrument.tone}" data-crossfade>${instrument.phase}</h2>${scopeMenuMarkup(instrument.measurementScope)}</div>
    <div class="instrument-readout" data-measured="${String(reading !== null)}" data-quiet="${String(quiet)}">
      <div class="instrument-measure">
      ${reading ? html`<div class="instrument-primary" data-live="${String(reading.live)}" data-basis="${reading.basis}" data-arrive><div class="speed-value"><span class="sr-only">${reading.text}${reading.unit ? ' tokens per second' : ''}</span><strong id="${READOUT_ID[reading.kind]}" aria-hidden="true" data-roll-value="${reading.kind === 'speed' ? compactRate(reading.text) : reading.text}" data-roll-context="${instrument.phase}/${instrument.measurementScope}/${reading.basis}/${reading.label}">${digitMarkup(reading.kind === 'speed' ? compactRate(reading.text) : reading.text)}</strong>${reading.unit ? html`<span aria-hidden="true">${reading.unit}</span>` : ''}<div class="instrument-source" data-crossfade>${reading.label}${measurementTip!.btn}<span class="sr-only basis">${reading.detail}</span></div></div></div>` : ''}
      ${instrument.held ? html`<p class="instrument-held" data-held="true" data-arrive title="${instrument.held.detail}">${instrument.held.text}</p>` : ''}
      ${result && instrument.support ? html`<p class="coverage-note"><time>${instrument.support.text}</time></p>` : ''}${notes}${measurementTip?.pop ?? ''}
      </div>
      <div class="instrument-evidence">${prefill ? html`<div class="instrument-prefill" id="prefill-progress"><div class="progress-track" role="progressbar" aria-label="Prompt progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${prefill.fraction * 100}"><span style="width:${pct100(prefill.fraction)}"></span></div>${prefill.counts ? html`<p class="coverage-note">Engine · ${prefill.counts}</p>` : ''}${prefill.eta ? html`<p class="coverage-note" data-basis="estimate">About ${prefill.eta} left · <span class="basis">Server estimate</span></p>` : ''}</div>` : tiles(facts, result?.label ?? 'Engine')}</div>
    </div>
    ${h.engineTrend?.chart ? html`<div id="engine-trend">${chartMarkup(h.engineTrend.chart)}</div>` : ''}
    ${h.chatOnly ? '' : html`<div id="reply-strip" class="instrument-support"><details class="instrument-detail-container" id="measurement-details"${flag('open', open.has('measurement-details'))}><summary>Measurement details${DISCLOSURE_ARROW}</summary><div class="instrument-detail-content">
    <details class="instrument-details" id="engine-readings"${flag('open', open.has('engine-readings'))}><summary>Engine readings${DISCLOSURE_ARROW}</summary><p class="instrument-model" id="model" translate="no">${h.title}</p>${h.attr ? html`<span class="title-row" id="attribution">${chip(h.attr.chip)}${a!.btn}</span>${a!.pop}` : ''}${speedsMarkup(h.speeds, false)}<div class="instrument-basis">${h.speeds.source} · All engine activity ${explanation?.btn ?? ''}</div>${explanation?.pop ?? ''}${averagesMarkup(h.speeds)}</details>
    ${remaining.length || h.context ? html`<details class="reading-details" id="request-details"${flag('open', open.has('request-details'))}><summary>Request details${DISCLOSURE_ARROW}</summary>${h.context ? html`<div class="context-headroom" id="context-headroom"><div class="context-line"><span class="title-row">Context used ${c!.btn}</span><span data-basis="${h.context.basis}"><strong>${h.context.used}</strong>${h.context.basis !== 'reported' ? html` <small class="basis">${BASIS_WORD[h.context.basis]}</small>` : ''}</span></div>${c!.pop}${meter(h.context.fraction)}</div>` : ''}${tiles(remaining)}</details>` : ''}
    ${h.reply && !h.reply.empty ? html`<details class="reading-details" id="last-reply"${flag('open', open.has('last-reply'))}><summary>Last reply${DISCLOSURE_ARROW}</summary>${replyStrip(h.reply, open, h.title)}</details>` : ''}${machineSummary(mac)}
    </div></details>${nextRow(h.reply?.next ?? null, open)}</div>`}
  </section>${h.chatOnly ? html`<p class="coverage-note cloud-scope">Cloud speed is delivery observed through OpenCode, including network and provider buffering. Not engine throughput.</p>` : ''}`;
};
const tiles = (list: readonly Tile[], primary: string | null = null): Raw | string => list.length ? html`<div class="metrics${primary ? ' engine-facts' : ''}" id="${primary ? primary === 'Engine' ? 'engine-facts' : 'completed-facts' : 'metrics'}" data-count="${list.length}" aria-label="${primary ?? 'Engine request'}">${primary ? html`<span class="engine-facts-heading">${primary}</span>` : ''}${list.map(tile =>
  html`<div${tile.label === 'First token' ? html` id="first-token"` : ''}><span class="metric-label">${tile.label}</span><strong data-basis="${tile.basis ?? 'reported'}">${tile.value}</strong>${tile.detail ? html`<span class="metric-detail">${tile.detail}</span>` : ''}${tile.basis && tile.basis !== 'reported' ? html`<span class="basis">${BASIS_WORD[tile.basis]}</span>` : ''}${tile.meter === null ? '' : meter(tile.meter)}</div>`)}</div>` : '';
const macRow = (row: MacRow, open: Open): Raw => {
  const t = tipParts(P, row.tip, open);
  return html`<div class="mac-row" data-key="mac-${row.key}"><span${t.btn ? html` class="title-row"` : ''}>${row.label}${t.btn ? ' ' : ''}${t.btn}</span>${row.level ? html`<strong class="level" data-level="${row.level}">${row.value.text}</strong>` : val(row.value)}${row.meter === null ? '' : meter(row.meter)}${t.pop}</div>`;
};
export const macCard = (mac: MacView | null, open: Open): Raw | string => {
  if (!mac) return '';
  const t = tipParts(P, mac.tip, open), detailsId = 'mac-details';
  return html`<section class="machine" id="machine" aria-label="${mac.title}" data-stale="${String(mac.stale)}"><div class="title-row"><h2 class="machine-title">${mac.title}</h2>${t.btn}</div>${t.pop}${mac.line.length ? html`<div class="machine-line">${mac.line.map(item => html`<div><span class="machine-label">${item.label}</span><strong>${item.value}</strong>${item.meter === null ? '' : meter(item.meter)}</div>`)}</div>` : ''}${mac.rows.length ? html`<div class="mac-rows">${mac.rows.map(row => macRow(row, open))}</div>` : ''}${mac.details.length ? html`<details class="host-details" id="${detailsId}"${flag('open', open.has(detailsId))}><summary>Mac details${DISCLOSURE_ARROW}</summary><div class="mac-rows">${mac.details.map(row => macRow(row, open))}</div></details>` : ''}</section>`;
};

const machineSummary = (mac: MacView | null): Raw | string => {
  if (!mac) return '';
  return html`<section class="machine-summary" aria-label="${mac.title}" data-stale="${String(mac.stale)}"><h2>${mac.title}</h2><div class="machine-summary-values">${mac.line.filter(item => item.label !== 'Swap').map(item => html`<span>${item.label} <strong>${item.value}</strong></span>`)}</div><div class="machine-health">${mac.rows.filter(row => row.level !== 'normal').map(row => html`<span class="level" data-level="${row.level ?? 'normal'}">${row.key === 'pressure' ? 'Memory' : 'Heat'} ${row.value.text.toLowerCase()}</span>`)}</div></section>`;
};

export const liveMarkup = (view: LiveView, open: Open): Raw => html`${callouts(P, view.callouts, open)}${hero(view.hero, view.tiles, open, view.mac)}${!view.hero ? html`${tiles(view.tiles)}${machineSummary(view.mac)}` : ''}`;
