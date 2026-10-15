import { actionButton } from './parts.ts';
import { digitMarkup } from '../digit-roll.ts';
import { BASIS_WORD, tip } from '../../present/parts.ts';
import { dur, kt } from '../../present/format.ts';
import { SPLASH_SPEED_HELP } from '../../present/speeds.ts';
import { tile, type HeroView, LiveView, MacRow, MacView, NextView, ReplyView, Tile } from '../../present/live.ts';
import type { ChartView } from '../chart.ts';
import { html, type Part, type Raw } from '../html.ts';
import { averagesMarkup, compactRate, speedsMarkup } from './speeds.ts';
import { measurementLabel, READOUT_ID, scopeMenuMarkup } from './session.ts';
import { callouts, chip, disclosure, ICON, meter, pct100, tipParts, val, type Open } from './parts.ts';

// Activity, speed and available engine context share one flat instrument.

/** Conservative advance budget with ink margin: keep a complete reading on one line at enlarged text sizes. */
const readoutWidth = (value: string): string => Math.max(1.5, [...value].reduce((width, char) =>
  width + (/[\d]/.test(char) ? .64 : /[.,:\s]/.test(char) ? .3 : /[%MWmw]/.test(char) ? 1 : .78) - .065, .15)).toFixed(3);

const P = 'live';
const chartMarkup = (chart: ChartView, held = false, endpoint = false): Raw => {
  const end = endpoint ? chart.line.match(/([\d.]+) ([\d.]+)$/) : null;
  if (endpoint) {
    // Next fits the readings actually received. The shared 90 s history, gaps and vertical scale are unchanged.
    const xs = Array.from(chart.line.matchAll(/[ML]([\d.]+)/g), match => Number(match[1]));
    const first = Math.min(...xs), last = Math.max(...xs), right = last;
    const span = Math.max(0, right - first), inset = Math.max(.2, span * .008), left = first - inset, width = Math.max(1, span + inset * 2);
    const seconds = Math.round(span / 592 * 90);
    const mark = chart.mark !== null && chart.mark >= first && chart.mark <= right ? chart.mark : null;
    const grid = `M${first} 4H${right} M${first} 60H${right} M${first} 116H${right} M${first} 4V116 M${first + span / 3} 4V116 M${first + span * 2 / 3} 4V116 M${right} 4V116`;
    return html`<figure class="signal precision-signal" id="signal" data-current="${String(!held)}" data-short="${String(seconds < 10)}"><div class="chart-top"><span>Engine trend</span><span id="ceiling">${chart.ceiling.replace('tok/s', 'tokens/s')}</span></div><div class="plot" role="img" aria-label="${held ? chart.label.replace(/, now /, ', last reading ') : chart.label}"><svg viewBox="${left.toFixed(2)} 0 ${width.toFixed(2)} 120" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="precision-trace-fill" x1="0" y1="0" x2="0" y2="1"><stop class="trace-wash-start" offset="0"/><stop class="trace-wash-end" offset="1"/></linearGradient></defs><path class="grid" d="${grid}"/><path class="trace-area" d="${chart.area}"/><path class="trace" d="${chart.line}"/>${mark === null ? '' : html`<line class="mark" x1="${mark}" x2="${mark}" y1="4" y2="116"/>`}</svg>${end ? html`<span class="trace-endpoint" aria-hidden="true" style="left:${((Number(end[1]) - left) / width * 100).toFixed(2)}%;top:${(Number(end[2]) / 1.2).toFixed(2)}%"></span>` : ''}</div><figcaption><span>${seconds ? `−${seconds}s` : 'Just started'}</span>${seconds >= 10 ? html`<span>−${Math.round(seconds * 2 / 3)}s</span><span>−${Math.round(seconds / 3)}s</span>` : ''}<span>${held ? 'last reading' : 'now'}</span></figcaption>${mark === null ? '' : html`<p class="trace-note">┊ Turn start</p>`}</figure>`;
  }
  return html`<figure class="signal" id="signal"><div class="chart-top"><span>Engine trend · 90 seconds</span><span id="ceiling">${chart.ceiling}</span></div><div class="plot" role="img" aria-label="${held ? chart.label.replace(/, now /, ", last reading ") : chart.label}"><svg viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true"><path class="grid" d="M4 4H596 M4 60H596 M4 116H596"/><path class="trace-area" d="${chart.area}"/><path class="trace" d="${chart.line}"/>${end ? html`<circle class="trace-endpoint" cx="${end[1]}" cy="${end[2]}" r="2.4"/>` : ''}${chart.mark === null ? '' : html`<line class="mark" x1="${chart.mark}" x2="${chart.mark}" y1="4" y2="116"/>`}</svg></div><figcaption><span>−90s</span><span>${chart.title.startsWith('Recent generation speed') ? 'Each reading covers up to 5 s' : 'Recent generation speed'}${chart.mark === null ? '' : ' · turn start ┊'}</span><span>${held ? 'last reading' : 'now'}</span></figcaption></figure>`;
};
const nextButton = actionButton;
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
  return html`<div class="reply-strip"><div class="reply-head"><span class="label">Last reply</span>${chip(reply.chip)}${t.btn}${reply.when ? html`<time>${reply.when}</time>` : ''}</div>${t.pop}${reply.model && reply.model !== currentModel ? html`<p class="reply-model" translate="no">${reply.model}</p>` : ''}<div class="reply-values">${primary.map(val)}${chip(reply.usual)}</div>${details.length || reply.split.length ? disclosure('reply-details', 'Reply details', html`<div class="reply-values">${details.map(val)}</div>${reply.split.length ? html`<div class="split">${reply.split.map(val)}</div>` : ''}`, open) : ''}</div>`;
};
const hero = (h: HeroView | null, list: readonly Tile[], open: Open, mac: MacView | null, next = false): Raw | string => {
  if (!h) return '';
  const a = h.attr ? tipParts(P, h.attr.tip, open) : null, c = h.context ? tipParts(P, h.context.tip, open) : null;
  const instrument = h.instrument, reading = instrument.measurement;
  const readingText = reading ? reading.kind === 'speed' ? compactRate(reading.text) : reading.text : '';
  const explanation = h.speeds.source === 'Splash' ? tipParts(P, tip('basis', 'How engine speeds are measured', SPLASH_SPEED_HELP), open)
    : h.body?.kind === 'decode' || h.body?.kind === 'prefill' ? tipParts(P, h.body.tip, open) : null;
  const measurementTip = reading ? tipParts(P, tip('measurement', reading.label, [reading.detail]), open) : null;
  const readingSource = reading ? html`<div class="instrument-source" data-crossfade="${reading.label}">${measurementLabel(reading, next)}${measurementTip!.btn}<span class="sr-only basis">${reading.detail}</span></div>` : '';
  const prefill = reading?.kind === 'progress' && h.body?.kind === 'prefill' ? h.body : null;
  const result = reading?.result;
  const fallback = list.filter(tile => ['Active requests', 'Model memory', 'Metal allocations', 'Median first token'].includes(tile.label));
  const facts: Tile[] = result ? ([
    ['Output', result.outputTokens, kt, 'reported'],
    [result.timing === 'step' ? 'Step duration' : 'Duration', result.durationMs, dur, 'derived'],
    ['First token', result.ttftMs, dur, reading!.basis],
  ] as const).flatMap(([label, value, format, basis]) => value == null ? [] : [tile(label, format(value), label === 'Output' ? 'tokens' : '', null, basis)]) : fallback.length ? fallback.slice(0, 3) : reading?.live && !prefill ? list.filter(tile => tile.label === 'Output' || tile.label === 'Elapsed' && reading.kind !== 'elapsed') : [];
  if (reading?.live && !prefill && h.firstToken && facts.length < 3) facts.push(tile('First token', h.firstToken.strong!, '', null, h.firstToken.basis));
  // A reading, held line, support fact or note keeps its part present. Only a wholly empty readout sheds its outer spacing;
  // populated parts take their natural height, including when enlarged text wraps.
  const hasSupport = !!(instrument.support && !instrument.alert);
  const noteShown = !!(instrument.note && !instrument.alert) || (h.body?.kind === 'word' && !reading && h.speeds.source !== 'Splash') || h.body?.kind === 'paused';
  const measureQuiet = !reading && !instrument.held && !hasSupport && !noteShown;
  const evidenceQuiet = !prefill && !facts.length;
  const remaining = list.filter(tile => !facts.includes(tile));
  // Suppress only an identical current engine count/timing already named in the visible facts. Unknown support,
  // progress, estimates and retained results keep their explanatory line.
  const supportCovered = next && reading?.live && reading.label === 'Engine' && facts.some(fact =>
    (fact.basis ?? 'reported') === (instrument.support?.basis ?? 'reported') && (
      fact.label === 'Output' && instrument.support?.text === `Engine · ${fact.value} tokens out`
      || fact.label === 'First token' && instrument.support?.text === `Engine · First token ${fact.value}`));
  const notes = html`${instrument.note && !instrument.alert ? html`<p class="coverage-note">${instrument.note}</p>` : ''}${h.body?.kind === 'word' && !reading && h.speeds.source !== 'Splash' ? html`<p class="coverage-note">${h.body.unit}${h.body.note ? html` · ${val(h.body.note)}` : ''}</p>` : ''}${h.body?.kind === 'paused' ? html`<p class="coverage-note" id="paused-note">${h.body.note}</p>` : ''}`;
  return html`<section class="hero-card" id="hero" aria-label="Activity and speed" data-arrive>
    <div class="instrument-heading">${next ? html`<div class="precision-identity"><h2 class="instrument-phase" data-tone="${instrument.tone}" data-live="${String(!!reading?.live)}" data-crossfade>${instrument.phase}</h2>${!h.chatOnly ? html`<p class="precision-engine"><span>${h.speeds.source}</span>${h.model ? html`<span class="precision-model" translate="no">${h.model}</span>` : ''}</p>` : ''}</div><label class="precision-watch"><span>Watch</span>${scopeMenuMarkup(instrument.measurementScope)}</label>` : html`<h2 class="instrument-phase" data-tone="${instrument.tone}" data-crossfade>${instrument.phase}</h2>${scopeMenuMarkup(instrument.measurementScope)}`}</div>
    <div class="instrument-readout" data-measured="${String(reading !== null)}" data-quiet="${String(measureQuiet && evidenceQuiet)}">
      <div class="instrument-measure" data-quiet="${String(measureQuiet)}">
      ${reading ? html`<div class="instrument-primary" data-live="${String(reading.live)}" data-basis="${reading.basis}" data-arrive><div class="speed-value"><span class="sr-only">${reading.text}${reading.unit ? ' tokens per second' : ''}</span><strong id="${READOUT_ID[reading.kind]}" aria-hidden="true"${next ? html` style="--reading-width:${readoutWidth(readingText)}"` : html` data-roll-value="${readingText}" data-roll-context="${instrument.phase}/${instrument.measurementScope}/${reading.basis}/${reading.label}"`}>${next ? readingText : digitMarkup(readingText)}</strong>${next ? html`<div class="precision-reading-context">${reading.unit ? html`<span class="precision-unit" aria-hidden="true">${reading.unit === 'tok/s' ? 'tokens/s' : reading.unit}</span>` : ''}${readingSource}</div>` : html`${reading.unit ? html`<span aria-hidden="true">${reading.unit}</span>` : ''}${readingSource}`}</div></div>` : ''}
      ${instrument.held ? html`<p class="instrument-held" data-held="true" data-arrive title="${instrument.held.detail}">${instrument.held.text}</p>` : ''}
      ${instrument.support && !instrument.alert && !supportCovered ? html`<p class="coverage-note">${result ? html`<time>${instrument.support.text}</time>` : instrument.support.text}${instrument.support.basis && instrument.support.basis !== 'reported' ? html` <span class="basis">${BASIS_WORD[instrument.support.basis]}</span>` : ''}</p>` : ''}${notes}${measurementTip?.pop ?? ''}
      </div>
      <div class="instrument-evidence" data-quiet="${String(evidenceQuiet)}">${prefill ? html`<div class="instrument-prefill" id="prefill-progress"><div class="progress-track" role="progressbar" aria-label="Prompt progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${prefill.fraction * 100}"><span style="width:${pct100(prefill.fraction)}"></span></div>${prefill.counts ? html`<p class="coverage-note">Engine · ${prefill.counts}</p>` : ''}${prefill.eta ? html`<p class="coverage-note" data-basis="estimate">About ${prefill.eta} left · <span class="basis">Server estimate</span></p>` : ''}</div>` : tiles(facts, result?.label ?? 'Engine', !next || !reading?.live || reading.label !== 'Engine')}</div>
    </div>
    ${h.engineTrend?.chart ? html`<div id="engine-trend">${chartMarkup(h.engineTrend.chart, next && h.engineTrend.current === false, next)}</div>` : ''}
    ${h.chatOnly ? '' : html`<div id="reply-strip" class="instrument-support">${disclosure('measurement-details', 'Measurement details', html`<div class="instrument-detail-content">
    ${disclosure('engine-readings', 'Engine readings', html`<p class="instrument-model" id="model" translate="no">${h.title}</p>${h.attr ? html`<span class="title-row" id="attribution">${chip(h.attr.chip)}${a!.btn}</span>${a!.pop}` : ''}${speedsMarkup(h.speeds, false)}<div class="instrument-basis">${h.speeds.source} · All engine activity ${explanation?.btn ?? ''}</div>${explanation?.pop ?? ''}${averagesMarkup(h.speeds)}`, open, 'instrument-details')}
    ${remaining.length || h.context ? disclosure('request-details', 'Request details', html`${h.context ? html`<div class="context-headroom" id="context-headroom"><div class="context-line"><span class="title-row">Context used ${c!.btn}</span><span data-basis="${h.context.basis}"><strong>${h.context.used}</strong>${h.context.basis !== 'reported' ? html` <small class="basis">${BASIS_WORD[h.context.basis]}</small>` : ''}</span></div>${c!.pop}${meter(h.context.fraction)}</div>` : ''}${tiles(remaining)}`, open) : ''}
    ${h.reply && !h.reply.empty ? disclosure('last-reply', 'Last reply', html`${replyStrip(h.reply, open, h.title)}`, open) : ''}${machineSummary(mac)}
    ${next ? html`<nav class="precision-detail-actions" aria-label="More from Scope">${actionButton('open-run', 'Run details')}${actionButton('open-server', 'Server & Mac details')}</nav>` : ''}</div>`, open, 'instrument-detail-container')}${nextRow(h.reply?.next ?? null, open)}</div>`}
  </section>${h.chatOnly ? html`<p class="coverage-note cloud-scope">Cloud speed is delivery observed through OpenCode, including network and provider buffering. Not engine throughput.</p>` : ''}`;
};
const tiles = (list: readonly Tile[], primary: string | null = null, heading = true): Raw | string => list.length ? html`<div class="metrics${primary ? ' engine-facts' : ''}" id="${primary ? primary === 'Engine' ? 'engine-facts' : 'completed-facts' : 'metrics'}" data-count="${list.length}" aria-label="${primary ?? 'Engine request'}">${primary && heading ? html`<span class="engine-facts-heading">${primary}</span>` : ''}${list.map(tile =>
  html`<div${tile.label === 'First token' ? html` id="first-token"` : ''}><span class="metric-label">${tile.label}</span><strong data-basis="${tile.basis ?? 'reported'}">${tile.value}</strong>${tile.detail ? html`<span class="metric-detail">${tile.detail}</span>` : ''}${tile.basis && tile.basis !== 'reported' ? html`<span class="basis">${BASIS_WORD[tile.basis]}</span>` : ''}${tile.meter === null ? '' : meter(tile.meter)}</div>`)}</div>` : '';
const macRow = (row: MacRow, open: Open): Raw => {
  const t = tipParts(P, row.tip, open);
  return html`<div class="mac-row" data-key="mac-${row.key}"><span${t.btn ? html` class="title-row"` : ''}>${row.label}${t.btn ? ' ' : ''}${t.btn}</span>${row.level ? html`<strong class="level" data-level="${row.level}">${row.value.text}</strong>` : val(row.value)}${row.meter === null ? '' : meter(row.meter)}${t.pop}</div>`;
};
export const macCard = (mac: MacView | null, open: Open): Raw | string => {
  if (!mac) return '';
  const t = tipParts(P, mac.tip, open), detailsId = 'mac-details';
  return html`<section class="machine" id="machine" aria-label="${mac.title}" data-stale="${String(mac.stale)}"><div class="title-row"><h2 class="machine-title">${mac.title}</h2>${t.btn}</div>${t.pop}${mac.line.length ? html`<div class="machine-line">${mac.line.map(item => html`<div><span class="machine-label">${item.label}</span><strong>${item.value}</strong>${item.meter === null ? '' : meter(item.meter)}</div>`)}</div>` : ''}${mac.rows.length ? html`<div class="mac-rows">${mac.rows.map(row => macRow(row, open))}</div>` : ''}${mac.details.length ? disclosure(detailsId, 'Mac details', html`<div class="mac-rows">${mac.details.map(row => macRow(row, open))}</div>`, open, 'host-details') : ''}</section>`;
};

const machineSummary = (mac: MacView | null): Raw | string => {
  if (!mac) return '';
  const values = mac.line.filter(item => item.label !== 'Swap'), health = mac.rows.filter(row => row.level !== 'normal');
  return html`<section class="machine-summary" aria-label="${mac.title}" data-stale="${String(mac.stale)}"><h2>${mac.title}</h2>${values.length ? html`<div class="machine-summary-values">${values.map(item => html`<span>${item.label} <strong>${item.value}</strong></span>`)}</div>` : ''}${health.length ? html`<div class="machine-health">${health.map(row => html`<span class="level" data-level="${row.level ?? 'normal'}">${row.key === 'pressure' ? 'Memory' : 'Heat'} ${row.value.text.toLowerCase()}</span>`)}</div>` : ''}</section>`;
};

export const liveMarkup = (view: LiveView, open: Open, next = false): Raw => {
  const main = html`${callouts(P, view.callouts, open)}${hero(view.hero, view.tiles, open, next ? null : view.mac, next)}${!view.hero ? html`${tiles(view.tiles)}${next ? '' : machineSummary(view.mac)}` : ''}`;
  return next ? html`<div class="next-live-primary">${main}</div>${view.mac ? html`<aside class="next-live-context" aria-label="This Mac">${macCard(view.mac, open)}<div id="next-context-activity" data-mount></div></aside>` : ''}` : main;
};
