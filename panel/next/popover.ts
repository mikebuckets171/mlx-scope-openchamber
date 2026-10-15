import type { HostClient, HostReadyContext, JsonValue } from '../host/types.ts';
import type { SessionSectionView } from '../present/session.ts';
import { html, morph } from '../render/html.ts';
import { applyHostReady } from '../sdk-theme.ts';

export interface ReadingCard { title: string; value: string; detail: string; facts: string[]; observedAt: number }
export const readingCard = (view: SessionSectionView, observedAt: number): ReadingCard => ({
  title: view.phase, value: view.measurement ? `${view.measurement.text}${view.measurement.unit ? ` ${view.measurement.unit}` : ''}` : '',
  detail: view.measurement?.detail ?? view.note ?? '', facts: [view.eta ? `${view.eta.text}. ${view.eta.detail}` : null, view.support?.text, view.held?.text, view.alert?.label].filter((value): value is string => !!value),
  observedAt,
});
export const parseReadingCard = (value: unknown): ReadingCard | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>, text = (value: unknown): value is string => typeof value === 'string' && value.length <= 500;
  if (!text(data.title) || !text(data.value) || !text(data.detail) || !Array.isArray(data.facts) || data.facts.length > 8 || !data.facts.every(text)
      || typeof data.observedAt !== 'number' || !Number.isFinite(data.observedAt)) return null;
  return { title: data.title, value: data.value, detail: data.detail, facts: data.facts, observedAt: data.observedAt };
};
export const openReadingCard = (host: HostClient, anchor: HTMLElement, data: ReadingCard): Promise<void> => {
  if (!host.openPopover) return Promise.reject(new Error('Popovers unavailable'));
  const { x, y, width, height } = anchor.getBoundingClientRect();
  return host.openPopover({ id: `scope-${Date.now()}`, anchor: { x, y, width, height }, width: 320, height: 240, side: 'left', focus: true,
    data: data as unknown as JsonValue });
};
/** A data-only child. This module creates no collectors, subscriptions, timers, or storage reads. */
export const renderReadingPopover = (root: HTMLElement, ready: HostReadyContext): void => {
  applyHostReady(ready, document.documentElement);
  const card = parseReadingCard(ready.popover?.data);
  document.documentElement.dataset.designMode = 'next';
  morph(root, card ? html`<section class="scope reading-popover" aria-label="Measurement details"><h2>${card.title}</h2>${card.value ? html`<p class="popover-value">${card.value}</p>` : ''}<p>${card.detail}</p>${card.facts.map(fact => html`<p class="coverage-note">${fact}</p>`)}<p class="coverage-note">Snapshot taken when opened</p></section>`
    : html`<p role="status">Measurement details are unavailable.</p>`);
};
