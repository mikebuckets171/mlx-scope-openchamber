import type { SpeedsView } from '../../present/speeds.ts';
import { html, type Raw } from '../html.ts';
export const compactRate = (value: string): string => {
  if (value.length <= 6) return value;
  const n = Number(value.replaceAll(',', ''));
  if (n >= 1e15) return n.toExponential(1).replace('.0e', 'e');
  const scale = n >= 1e12 ? [1e12, 'T'] as const : n >= 1e9 ? [1e9, 'B'] as const : n >= 1e6 ? [1e6, 'M'] as const : [1e3, 'K'] as const;
  return `${+(n / scale[0]).toFixed(1)}${scale[1]}`;
};
/** Detailed engine lanes; the Session reading uses its shared activity presenter. */
export const speedsMarkup = (view: SpeedsView, identifyRate = true): Raw => html`<div class="speed-pair" aria-label="Current speeds">${view.speeds.map(speed => html`<section class="speed-lane" data-stage="${speed.key}" data-active="${String(speed.active)}" data-basis="${speed.basis}"><h3>${speed.label}</h3><div class="speed-value"${speed.value !== null ? html` aria-label="${speed.value} tokens per second"` : ''}><strong aria-hidden="true"${identifyRate && speed.key === 'generation' && speed.value !== null ? html` id="rate"` : ''}>${speed.value !== null ? compactRate(speed.value) : '—'}</strong>${speed.value !== null ? html`<span aria-hidden="true">tok/s</span><span class="sr-only">${speed.value} tokens per second</span>` : ''}</div><p class="speed-source basis">${speed.detail}</p></section>`)}</div>`;
export const averagesMarkup = (view: SpeedsView): Raw | string => view.speeds.some(speed => speed.average !== null)
  ? html`<section class="speed-averages" aria-label="${view.averageTitle}"><div class="section-heading"><h3>${view.averageTitle}</h3><span>${view.averageNote}</span></div><dl>${view.speeds.map(speed => html`<div><dt>${speed.key === 'prefill' ? 'Prefill speed' : speed.label}</dt><dd>${speed.average ?? '—'}${speed.average !== null ? html` <small>tok/s</small>` : ''}</dd></div>`)}</dl></section>` : '';
