import type { SessionMeasurement, SessionSectionView } from '../../present/session.ts';
import { BASIS_WORD } from '../../present/parts.ts';
import { flag, html, type Raw } from '../html.ts';
import { compactRate, readoutWidth } from './speeds.ts';

/** Stable readout ids per kind: a % or an elapsed time is never addressed as a rate. */
export const READOUT_ID = { speed: 'rate', progress: 'prefill-percent', elapsed: 'elapsed' } as const;

/** Two layers: "This chat" or "Engine". How the value was measured lives in the reading's explanation, not its label. */
export const measurementLabel = (reading: SessionMeasurement, _next = false): string => reading.label;
/** An estimate reads "≈ 24.1", never as a measured value. */
export const readoutText = (reading: SessionMeasurement): string =>
  `${reading.basis === 'estimate' ? '≈ ' : ''}${reading.kind === 'speed' ? compactRate(reading.text) : reading.text}`;

/** Native menus stay keyboard accessible and can open outside a short status iframe. */
export const scopeMenuMarkup = (scope: 'chat' | 'engine'): Raw => html`<select class="scope-choice" data-action="measurement-scope" aria-label="Measurement scope"><option value="chat"${flag('selected', scope === 'chat')}>This chat</option><option value="engine"${flag('selected', scope === 'engine')}>Engine</option></select>`;

export const sessionMarkup = (view: SessionSectionView, actionError: string | null = null, compact = false, next = false, options: SessionNextOptions = {}): Raw => {
  if (next && !compact) return nextSessionMarkup(view, actionError, options);
  const measurement = view.measurement, alert = view.alert, label = measurement ? measurementLabel(measurement, next) : '';
  const readingText = measurement ? readoutText(measurement) : '';
  return html`<div class="ws ws-session" id="ws" data-presentation="session" data-mode="summary" data-resting="${String(view.resting)}">
    <div class="ws-activity">
      <div class="ws-line ws-heading ws-context"><span class="ws-phase" data-tone="${view.tone}" data-crossfade>${view.phase}</span>${scopeMenuMarkup(view.measurementScope)}</div>
      ${measurement ? html`<div class="ws-line ws-measurement" data-live="${String(measurement.live)}" data-basis="${measurement.basis}" data-arrive title="${measurement.detail}"><span class="ws-reading" aria-hidden="true"><strong id="${READOUT_ID[measurement.kind]}" aria-hidden="true" style="--reading-width:${readoutWidth(readingText)}">${readingText}</strong>${measurement.unit ? html` <span aria-hidden="true">${measurement.unit}</span>` : ''}</span><span class="sr-only measurement-accessible">${measurement.basis === 'estimate' ? 'about ' : ''}${measurement.text}${measurement.unit ? ' tokens per second' : ''}</span><span class="ws-label" data-crossfade>${label}${view.eta ? html`<span class="prompt-eta">${view.eta.text}</span>` : ''}</span><span class="sr-only basis">${measurement.detail}</span></div>` : ''}
      ${view.support && !alert && !actionError && !view.note ? html`<div class="ws-line ws-support" title="${view.support.detail}">${view.support.text}${view.support.basis && view.support.basis !== 'reported' ? html` <span class="basis">${BASIS_WORD[view.support.basis]}</span>` : ''}</div>`
        : view.held && !alert && !actionError && !view.note ? html`<div class="ws-line ws-support ws-held" data-held="true" data-arrive title="${view.held.detail}">${view.held.text}</div>` : ''}
    ${!actionError && alert ? html`<div class="ws-line ws-warning" data-severity="${alert.severity}" title="${alert.label}">${alert.label}</div>` : !actionError && view.note ? html`<div class="ws-line ws-note" title="${view.note}">${view.note}</div>` : ''}
    ${actionError ? html`<p class="ws-action-error" id="ws-action-error" role="status">${actionError}</p>` : ''}
    </div>
    <div class="ws-actions"><button type="button" class="ws-details" data-action="${compact ? 'expand' : 'open-scope'}">${compact ? 'Expand' : 'Open MLX Scope'}</button></div>
  </div>`;
};

/** Presentation only: the compact instrument reuses the same reading and media controller. */
export interface SessionNextOptions { media?: Raw | string; paused?: boolean }

/**
 * The quiet Session section: the phase, one reading (with the prompt-time estimate while the prompt is read) and,
 * only when something is happening, up to two exception rows. Scope and Pause live in OpenChamber's section header when
 * the host draws them; this in-widget row stays until it does.
 */
const nextSessionMarkup = (view: SessionSectionView, actionError: string | null, options: SessionNextOptions): Raw => {
  const measurement = view.measurement;
  const label = measurement ? measurementLabel(measurement) : '';
  const rows = actionError ? [{ key: 'error', text: actionError, detail: actionError, severity: 'warning' as const }, ...view.exceptions].slice(0, 2)
    : view.exceptions.length ? view.exceptions
      : !measurement && !view.resting ? [{ key: 'empty', text: 'No measurement available', detail: '', severity: 'info' as const }] : [];
  const unit = measurement?.kind === 'speed' ? 'tokens/s' : measurement?.unit;
  const readingText = measurement ? readoutText(measurement) : '';
  return html`<div class="ws ws-session ws-next" id="ws" data-presentation="session" data-mode="summary" data-resting="${String(view.resting)}" tabindex="-1">
    <div class="ws-scroll" id="ws-scroll">
      <div class="ws-toolbar" id="ws-toolbar">
        <label class="ws-watch"><span class="sr-only">Watch</span>${scopeMenuMarkup(view.measurementScope)}</label>
        <button type="button" class="ws-control" data-action="pause">${options.paused ? 'Resume' : 'Pause'}</button>
        <button type="button" class="ws-control" data-action="reading-details">Details</button>
      </div>
      <section class="ws-instrument" aria-label="Session activity">
        <div class="ws-line ws-heading" id="ws-heading"><span class="ws-phase" data-tone="${view.tone}" data-live="${String(!!measurement?.live)}" data-crossfade><span class="ws-phase-dot" aria-hidden="true"></span>${view.phase}</span><span class="ws-runtime">${view.speeds.source}</span></div>
        <div class="ws-measurement" id="ws-measurement" data-live="${String(!!measurement?.live)}" data-basis="${measurement?.basis ?? 'unavailable'}" title="${measurement?.detail ?? ''}"${flag('hidden', !measurement)}>
          <span class="ws-reading" aria-hidden="true"><strong id="${measurement ? READOUT_ID[measurement.kind] : 'rate'}" style="--reading-width:${readoutWidth(readingText)}">${readingText}</strong>${unit ? html`<span>${unit}</span>` : ''}</span>
          <span class="sr-only measurement-accessible">${measurement?.basis === 'estimate' ? 'about ' : ''}${measurement?.text ?? ''}${measurement?.kind === 'speed' ? ' tokens per second' : unit ? ` ${unit}` : ''}</span>
          <span class="ws-label" data-crossfade>${label}${view.eta ? html`<span class="prompt-eta">${view.eta.text}</span>` : ''}</span><span class="sr-only basis">${measurement?.detail ?? ''}</span>
        </div>
        <div class="ws-exceptions" id="ws-notice"${actionError ? html` role="status"` : ''}${flag('hidden', !rows.length)}>${rows.map(row =>
          html`<p class="ws-notice ${row.key === 'error' ? 'ws-action-error' : row.severity === 'info' ? 'ws-note' : 'ws-warning'}" data-exception="${row.key}" data-severity="${row.severity === 'info' ? 'warning' : row.severity}" title="${row.detail}">${row.text}</p>`)}</div>
      </section>
      <div class="ws-media" id="ws-media"${flag('hidden', !options.media)}>${options.media ?? ''}</div>
    </div>
    <div class="ws-actions" id="ws-actions"><button type="button" class="ws-details ws-open" data-action="open-scope"><span>Open MLX Scope</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg></button></div>
  </div>`;
};
