import type { SessionMeasurement, SessionSectionView } from '../../present/session.ts';
import { flag, html, type Raw } from '../html.ts';
import { compactRate, readoutWidth } from './speeds.ts';

/** Stable readout ids per kind: a % or an elapsed time is never addressed as a rate. */
export const READOUT_ID = { speed: 'rate', progress: 'prefill-percent', elapsed: 'elapsed' } as const;

/** Two layers: "This chat" or "Engine". How the value was measured lives in the reading's explanation, not its label. */
export const measurementLabel = (reading: SessionMeasurement, _next = false): string => reading.label;
/** An estimate reads "≈ 24.1", never as a measured value. */
export const readoutText = (reading: SessionMeasurement): string =>
  `${reading.basis === 'estimate' ? '≈ ' : ''}${reading.kind === 'speed' ? compactRate(reading.text) : reading.text}`;

/** Native menus stay keyboard accessible and can open outside a short status iframe. Automatic follows the chat when its numbers are known and the engine otherwise. */
export const scopeMenuMarkup = (scope: 'auto' | 'engine'): Raw => html`<select class="scope-choice" data-action="measurement-scope" aria-label="What to watch"><option value="auto"${flag('selected', scope !== 'engine')}>Automatic</option><option value="engine"${flag('selected', scope === 'engine')}>Engine</option></select>`;

/**
 * One status-section presentation everywhere: the sidebar, the compact panel and the Work Status surface render the
 * same widget. The retired compact-only branch is gone; `next` stays in the signature for the existing call sites.
 */
export const sessionMarkup = (view: SessionSectionView, actionError: string | null = null, compact = false, next = true, options: SessionNextOptions = {}): Raw =>
  nextSessionMarkup(view, actionError, { ...options, compact });

/** Presentation only: the compact instrument reuses the same reading and media controller. */
export interface SessionNextOptions { media?: Raw | string; paused?: boolean; compact?: boolean }

/**
 * The quiet Session section: the phase, one reading (with the prompt-time estimate while the prompt is read) and,
 * only when something is happening, up to two exception rows. Scope and Pause live in OpenChamber's section header when
 * the host draws them; this in-widget row stays until it does. Compact drops that row: the panel masthead already
 * offers Pause and the ⋯ menu, so the glance keeps only the Watch choice and turns its action into Expand.
 */
const nextSessionMarkup = (view: SessionSectionView, actionError: string | null, options: SessionNextOptions): Raw => {
  const compact = options.compact === true;
  const measurement = view.measurement;
  const label = measurement ? measurementLabel(measurement) : '';
  const rows = actionError ? [{ key: 'error', text: actionError, detail: actionError, severity: 'warning' as const }, ...view.exceptions].slice(0, 2)
    : view.exceptions.length ? view.exceptions
      : !measurement && !view.resting ? [{ key: 'empty', text: view.speeds.source === 'Chat delivery' ? 'Chat speed is not on for this chat' : 'No measurement available', detail: view.speeds.source === 'Chat delivery' ? 'Open Connections → Chat speed → Enable to measure this chat’s delivery.' : '', severity: 'info' as const }] : [];
  const unit = measurement?.kind === 'speed' ? 'tokens/s' : measurement?.unit;
  const readingText = measurement ? readoutText(measurement) : '';
  const arrow = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>`;
  return html`<div class="ws ws-session ws-next" id="ws" data-presentation="session" data-mode="summary" data-resting="${String(view.resting)}" tabindex="-1">
    <div class="ws-scroll" id="ws-scroll">
      <div class="ws-toolbar" id="ws-toolbar">
        <label class="ws-watch"><span class="sr-only">Watch</span>${scopeMenuMarkup(view.measurementScope)}</label>
        ${compact ? '' : html`<button type="button" class="ws-control" data-action="pause">${options.paused ? 'Resume' : 'Pause'}</button>
        <button type="button" class="ws-control" data-action="reading-details">Details</button>`}
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
    <div class="ws-actions" id="ws-actions">${compact
      ? html`<button type="button" class="ws-details ws-open" data-action="expand"><span>Expand</span>${arrow}</button>`
      : html`<button type="button" class="ws-details ws-open" data-action="open-scope"><span>Open MLX Scope</span>${arrow}</button>`}</div>
  </div>`;
};
