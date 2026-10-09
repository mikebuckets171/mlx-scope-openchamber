import type { SessionSectionView } from '../../present/session.ts';
import { flag, html, type Raw } from '../html.ts';
import { compactRate } from './speeds.ts';

/** Native menus stay keyboard accessible and can open outside a short status iframe. */
export const scopeMenuMarkup = (scope: 'chat' | 'engine'): Raw => html`<select class="scope-choice" data-action="measurement-scope" aria-label="Measurement scope"><option value="chat"${flag('selected', scope === 'chat')}>This chat</option><option value="engine"${flag('selected', scope === 'engine')}>Whole engine</option></select>`;

export const sessionMarkup = (view: SessionSectionView, actionError: string | null = null, compact = false): Raw => {
  const measurement = view.measurement, alert = view.alert;
  return html`<div class="ws ws-session" id="ws" data-presentation="session" data-mode="summary" style="min-height:${view.height}px">
    <div class="ws-activity">
      <div class="ws-line ws-heading ws-context"><span class="ws-phase" data-tone="${view.tone}">${view.phase}</span>${scopeMenuMarkup(view.measurementScope)}</div>
      ${measurement ? html`<div class="ws-line ws-measurement" data-live="${String(measurement.live)}" data-basis="${measurement.basis}" title="${measurement.detail}"><span class="ws-reading"${measurement.unit ? html` aria-label="${measurement.text} tokens per second"` : ''}><strong${measurement.kind === 'speed' ? html` id="rate"` : ''}>${measurement.kind === 'speed' ? compactRate(measurement.text) : measurement.text}</strong>${measurement.unit ? html` <span>${measurement.unit}</span>` : ''}</span><span class="ws-label">${measurement.label}</span><span class="sr-only basis">${measurement.unit ? `${measurement.text} tokens per second. ` : ''}${measurement.detail}</span></div>` : ''}
    </div>
    ${alert ? html`<div class="ws-line ws-warning" data-severity="${alert.severity}" title="${alert.label}">${alert.label}</div>` : !actionError && view.note ? html`<div class="ws-line ws-note" title="${view.note}">${view.note}</div>` : ''}
    ${actionError ? html`<p class="ws-action-error" id="ws-action-error" role="status">${actionError}</p>` : ''}
    <div class="ws-actions"><button type="button" class="ws-details" data-action="${compact ? 'expand' : 'open-scope'}">${compact ? 'Expand' : 'Open MLX Scope'}</button>${view.cancelMeasurement ? html`<button type="button" class="ws-details" data-action="next-cancel">Cancel</button>` : ''}</div>
  </div>`;
};
