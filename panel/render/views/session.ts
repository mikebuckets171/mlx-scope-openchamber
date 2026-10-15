import { digitMarkup } from '../digit-roll.ts';
import type { SessionMeasurement, SessionSectionView } from '../../present/session.ts';
import { BASIS_WORD } from '../../present/parts.ts';
import { flag, html, type Raw } from '../html.ts';
import { compactRate } from './speeds.ts';
import type { ChartView } from '../chart.ts';

/** Stable readout ids per kind: a % or an elapsed time is never addressed as a rate. */
export const READOUT_ID = { speed: 'rate', progress: 'prefill-percent', elapsed: 'elapsed' } as const;

/** Keep the presenter's essential time basis visible beside a Next speed. */
export const measurementLabel = (reading: SessionMeasurement, next = false): string => {
  if (!next || !reading.live || reading.kind !== 'speed') return reading.label;
  const recent = reading.detail.match(/Calculated · last (\d+(?:\.\d+)? s)/)?.[1];
  const qualifier = reading.detail.includes('average for this request') ? 'request average' : recent ? `recent ${recent}` : '';
  return qualifier ? `${reading.label} · ${qualifier}` : reading.label;
};

/** Native menus stay keyboard accessible and can open outside a short status iframe. */
export const scopeMenuMarkup = (scope: 'chat' | 'engine'): Raw => html`<select class="scope-choice" data-action="measurement-scope" aria-label="Measurement scope"><option value="chat"${flag('selected', scope === 'chat')}>This chat</option><option value="engine"${flag('selected', scope === 'engine')}>Whole engine</option></select>`;

export const sessionMarkup = (view: SessionSectionView, actionError: string | null = null, compact = false, next = false, options: SessionNextOptions = {}): Raw => {
  if (next && !compact) return nextSessionMarkup(view, actionError, options);
  const measurement = view.measurement, alert = view.alert, label = measurement ? measurementLabel(measurement, next) : '';
  const readingText = measurement ? measurement.kind === 'speed' ? compactRate(measurement.text) : measurement.text : '';
  return html`<div class="ws ws-session" id="ws" data-presentation="session" data-mode="summary" data-resting="${String(view.resting)}">
    <div class="ws-activity">
      <div class="ws-line ws-heading ws-context"><span class="ws-phase" data-tone="${view.tone}" data-crossfade>${view.phase}</span>${scopeMenuMarkup(view.measurementScope)}</div>
      ${measurement ? html`<div class="ws-line ws-measurement" data-live="${String(measurement.live)}" data-basis="${measurement.basis}" data-arrive title="${measurement.detail}"><span class="ws-reading" aria-hidden="true"><strong id="${READOUT_ID[measurement.kind]}" aria-hidden="true"${next ? '' : html` data-roll-value="${readingText}" data-roll-context="${view.phase}/${view.measurementScope}/${measurement.basis}/${measurement.label}"`}>${next ? readingText : digitMarkup(readingText)}</strong>${measurement.unit ? html` <span aria-hidden="true">${measurement.unit}</span>` : ''}</span><span class="sr-only measurement-accessible">${measurement.text}${measurement.unit ? ' tokens per second' : ''}</span><span class="ws-label" data-crossfade>${label}</span><span class="sr-only basis">${measurement.detail}</span></div>` : ''}
      ${view.support && !alert && !actionError && !view.note ? html`<div class="ws-line ws-support" title="${view.support.detail}">${view.support.text}${view.support.basis && view.support.basis !== 'reported' ? html` <span class="basis">${BASIS_WORD[view.support.basis]}</span>` : ''}</div>`
        : view.held && !alert && !actionError && !view.note ? html`<div class="ws-line ws-support ws-held" data-held="true" data-arrive title="${view.held.detail}">${view.held.text}</div>` : ''}
    ${!actionError && alert ? html`<div class="ws-line ws-warning" data-severity="${alert.severity}" title="${alert.label}">${alert.label}</div>` : !actionError && view.note ? html`<div class="ws-line ws-note" title="${view.note}">${view.note}</div>` : ''}
    ${actionError ? html`<p class="ws-action-error" id="ws-action-error" role="status">${actionError}</p>` : ''}
    </div>
    <div class="ws-actions"><button type="button" class="ws-details" data-action="${compact ? 'expand' : 'open-scope'}">${compact ? 'Expand' : 'Open MLX Scope'}</button>${view.cancelMeasurement ? html`<button type="button" class="ws-details" data-action="next-cancel">Cancel</button>` : ''}</div>
  </div>`;
};

/** Presentation only: the compact instrument reuses the same reading, samples, and media controller. */
export interface SessionNextOptions { chart?: ChartView | null; media?: Raw | string; paused?: boolean; headerActive?: boolean }

const nextSessionMarkup = (view: SessionSectionView, actionError: string | null, options: SessionNextOptions): Raw => {
  const measurement = view.measurement, alert = view.alert, chart = options.chart;
  const label = measurement ? measurementLabel(measurement, true) : '';
  const support = !alert && !actionError && !view.note ? view.support : null;
  const held = !support && !alert && !actionError && !view.note ? view.held : null;
  // Give the two compact, already-present engine facts a readable label/value treatment.
  // Any other support copy keeps its complete sentence; no measurements are inferred here.
  const output = support?.text.match(/^(Engine · )?([\d.,]+[KM]?) tokens out$/);
  const firstToken = support?.text.match(/^(Engine · )?First token (.+)$/);
  const fact = output ? { label: output[1] ? 'Engine output' : 'Output', value: output[2]!, unit: 'tokens' }
    : firstToken ? { label: firstToken[1] ? 'Engine first token' : 'First token', value: firstToken[2]!, unit: '' } : null;
  const notice = actionError ?? alert?.label ?? view.note ?? (!measurement && !view.resting ? 'No measurement available' : '');
  // Fit the plot to the actual observed interval. There is no invented lead-in or interpolated history.
  const xs = chart ? Array.from(chart.line.matchAll(/[ML]([\d.]+)/g), match => Number(match[1])) : [];
  const first = xs.length ? Math.min(...xs) : 0, last = xs.length ? Math.max(...xs) : 600;
  const inset = Math.max(.2, (last - first) * .008), left = first - inset, width = Math.max(1, last - first + inset * 2);
  const interval = chart?.label.match(/last (\d+) s:/)?.[1];
  const end = chart?.line.match(/([\d.]+) ([\d.]+)$/);
  const unit = measurement?.kind === 'speed' ? 'tokens/s' : measurement?.unit;
  return html`<div class="ws ws-session ws-next" id="ws" data-presentation="session" data-mode="summary" data-resting="${String(view.resting)}" tabindex="-1">
    <div class="ws-scroll" id="ws-scroll">
      <div class="ws-toolbar" id="ws-toolbar"${flag('hidden', !!options.headerActive)}>
        <label class="ws-watch">Watch ${scopeMenuMarkup(view.measurementScope)}</label>
        <button type="button" class="ws-control" data-action="pause">${options.paused ? 'Resume' : 'Pause'}</button>
        <button type="button" class="ws-control" data-action="reading-details">Details</button>
      </div>
      <section class="ws-instrument" aria-label="Session activity">
        <div class="ws-line ws-heading" id="ws-heading"><span class="ws-phase" data-tone="${view.tone}" data-live="${String(!!measurement?.live)}" data-crossfade><span class="ws-phase-dot" aria-hidden="true"></span>${view.phase}</span><span class="ws-runtime">${view.speeds.source}</span></div>
        <div class="ws-measurement" id="ws-measurement" data-live="${String(!!measurement?.live)}" data-basis="${measurement?.basis ?? 'unavailable'}" title="${measurement?.detail ?? ''}"${flag('hidden', !measurement)}>
          <span class="ws-reading" aria-hidden="true"><strong id="${measurement ? READOUT_ID[measurement.kind] : 'rate'}">${measurement?.kind === 'speed' ? compactRate(measurement.text) : measurement?.text ?? ''}</strong>${unit ? html`<span>${unit}</span>` : ''}</span>
          <span class="sr-only measurement-accessible">${measurement?.text ?? ''}${measurement?.kind === 'speed' ? ' tokens per second' : unit ? ` ${unit}` : ''}</span>
          <span class="ws-label" data-crossfade>${label}</span><span class="sr-only basis">${measurement?.detail ?? ''}</span>
        </div>
        <figure class="ws-signal" id="ws-signal" aria-label="${chart?.label ?? ''}"${flag('hidden', !chart)}>
          ${chart ? html`<div class="ws-plot"><svg viewBox="${left.toFixed(1)} 0 ${width.toFixed(1)} 120" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="session-trace-fill" x1="0" y1="0" x2="0" y2="1"><stop class="trace-wash-start" offset="0"/><stop class="trace-wash-end" offset="1"/></linearGradient></defs><path class="grid" d="M${left.toFixed(1)} 60h${width.toFixed(1)} M${left.toFixed(1)} 116h${width.toFixed(1)}"/><path class="area" d="${chart.area}"/><path class="trace" d="${chart.line}" vector-effect="non-scaling-stroke"/></svg>${end ? html`<span class="ws-trace-endpoint" aria-hidden="true" style="left:${((Number(end[1]) - left) / width * 100).toFixed(2)}%;top:${(Number(end[2]) / 1.2).toFixed(2)}%"></span>` : ''}</div><figcaption><span>${interval ? `${interval} s observed` : 'Engine trend'}</span><span>Scale ${chart.ceiling.replace('tok/s', 'tokens/s')}</span></figcaption>` : ''}
        </figure>
        <div class="ws-line ws-support${held ? ' ws-held' : ''}" id="ws-support" data-fact="${String(!!fact)}"${flag('hidden', !support && !held)} title="${support?.detail ?? held?.detail ?? ''}">${fact ? html`<span class="ws-fact-label">${fact.label}</span><strong class="ws-fact-value">${fact.value}${fact.unit ? html`<span>${fact.unit}</span>` : ''}</strong>` : support?.text ?? held?.text ?? ''}${support?.basis && support.basis !== 'reported' ? html` <span class="basis">${BASIS_WORD[support.basis]}</span>` : ''}</div>
        <div class="ws-notice ${actionError ? 'ws-action-error' : alert ? 'ws-warning' : 'ws-note'}" id="ws-notice"${actionError ? html` role="status"` : ''} data-severity="${alert?.severity ?? 'warning'}"${flag('hidden', !notice)}>${notice}</div>
      </section>
      <div class="ws-media" id="ws-media"${flag('hidden', !options.media)}>${options.media ?? ''}</div>
    </div>
    <div class="ws-actions" id="ws-actions"><button type="button" class="ws-details ws-open" data-action="open-scope"><span>Open MLX Scope</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg></button>${view.cancelMeasurement ? html`<button type="button" class="ws-details" data-action="next-cancel">Cancel</button>` : ''}</div>
  </div>`;
};
