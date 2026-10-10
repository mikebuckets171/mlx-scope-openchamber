import { digitMarkup } from '../digit-roll.ts';
import type { SessionSectionView } from '../../present/session.ts';
import { BASIS_WORD } from '../../present/parts.ts';
import { flag, html, type Raw } from '../html.ts';
import { compactRate } from './speeds.ts';

/** Stable readout ids per kind: a % or an elapsed time is never addressed as a rate. */
export const READOUT_ID = { speed: 'rate', progress: 'prefill-percent', elapsed: 'elapsed' } as const;

/** Native menus stay keyboard accessible and can open outside a short status iframe. */
export const scopeMenuMarkup = (scope: 'chat' | 'engine'): Raw => html`<select class="scope-choice" data-action="measurement-scope" aria-label="Measurement scope"><option value="chat"${flag('selected', scope === 'chat')}>This chat</option><option value="engine"${flag('selected', scope === 'engine')}>Whole engine</option></select>`;

export const sessionMarkup = (view: SessionSectionView, actionError: string | null = null, compact = false): Raw => {
  const measurement = view.measurement, alert = view.alert;
  return html`<div class="ws ws-session" id="ws" data-presentation="session" data-mode="summary">
    <div class="ws-activity">
      <div class="ws-line ws-heading ws-context"><span class="ws-phase" data-tone="${view.tone}" data-crossfade>${view.phase}</span>${scopeMenuMarkup(view.measurementScope)}</div>
      ${measurement ? html`<div class="ws-line ws-measurement" data-live="${String(measurement.live)}" data-basis="${measurement.basis}" data-arrive title="${measurement.detail}"><span class="ws-reading" aria-hidden="true"><strong id="${READOUT_ID[measurement.kind]}" aria-hidden="true" data-roll-value="${measurement.kind === 'speed' ? compactRate(measurement.text) : measurement.text}" data-roll-context="${view.phase}/${view.measurementScope}/${measurement.basis}/${measurement.label}">${digitMarkup(measurement.kind === 'speed' ? compactRate(measurement.text) : measurement.text)}</strong>${measurement.unit ? html` <span aria-hidden="true">${measurement.unit}</span>` : ''}</span><span class="sr-only measurement-accessible">${measurement.text}${measurement.unit ? ' tokens per second' : ''}</span><span class="ws-label" data-crossfade>${measurement.label}</span><span class="sr-only basis">${measurement.detail}</span></div>` : ''}
      ${view.support && !alert && !actionError && !view.note ? html`<div class="ws-line ws-support" title="${view.support.detail}">${view.support.text}${view.support.basis && view.support.basis !== 'reported' ? html` <span class="basis">${BASIS_WORD[view.support.basis]}</span>` : ''}</div>`
        : view.held && !alert && !actionError && !view.note ? html`<div class="ws-line ws-support ws-held" data-held="true" data-arrive title="${view.held.detail}">${view.held.text}</div>` : ''}
    ${!actionError && alert ? html`<div class="ws-line ws-warning" data-severity="${alert.severity}" title="${alert.label}">${alert.label}</div>` : !actionError && view.note ? html`<div class="ws-line ws-note" title="${view.note}">${view.note}</div>` : ''}
    ${actionError ? html`<p class="ws-action-error" id="ws-action-error" role="status">${actionError}</p>` : ''}
    </div>
    <div class="ws-actions"><button type="button" class="ws-details" data-action="${compact ? 'expand' : 'open-scope'}">${compact ? 'Expand' : 'Open MLX Scope'}</button>${view.cancelMeasurement ? html`<button type="button" class="ws-details" data-action="next-cancel">Cancel</button>` : ''}</div>
  </div>`;
};
