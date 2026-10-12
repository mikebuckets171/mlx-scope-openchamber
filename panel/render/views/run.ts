import type { RunComparison, RunDetail } from '../../present/run.ts';
import { BASIS_WORD } from '../../present/parts.ts';
import { box, button, el, group, morph, section, strong, val } from './history-parts.ts';

/** The inspector shares History's section, metric and control primitives; absent facts create no rows. */
export const renderRun = (root: HTMLElement, detail: RunDetail, references: Array<{ key: string; label: string }> | null,
  reference: string, comparison: RunComparison[], focus: boolean): void => {
  const body = group(
    detail.identity ? el('p', { class: 'insight-note', translate: 'no' }, detail.identity) : null,
    detail.facts.length ? el('dl', { class: 'kv' }, detail.facts.map(fact => group(
      el('dt', {}, `${fact.scope ? `${fact.scope} · ` : ''}${fact.label}`),
      el('dd', {}, val(strong(fact.value), fact.basis, BASIS_WORD[fact.basis]))))) : null,
    detail.notes.map(note => el('p', { class: 'insight-note' }, note)),
    references ? references.length ? [
      el('label', { class: 'insight-actions' }, 'Compare with', el('select', { class: 'btn', 'data-action': 'run-reference', 'data-focus': 'run-reference' },
        el('option', { value: '' }, 'Choose a recorded reply'), references.map(item => el('option', { value: item.key, selected: item.key === reference }, item.label)))),
      comparison.length ? el('dl', { class: 'kv run-comparison' }, comparison.map(metric => group(el('dt', {}, metric.label), el('dd', {},
        val(strong(metric.change), 'derived', 'calculated'), ` · ${metric.current} vs ${metric.reference}`, el('small', { class: 'basis' }, metric.group))))) : null,
      el('p', { class: 'insight-note' }, comparison.length
        ? 'Two recorded replies · same runtime, model, measurement basis and metric group. Hardware, settings and workload can differ; this is not a controlled benchmark.'
        : 'Only replies with at least one compatible metric are offered. Each comparison uses its own context or uncached-input group.'),
    ] : el('p', { class: 'insight-note' }, 'No comparable replies: a reported metric, matching model, runtime, basis and size group are required; overlapping and estimated results are excluded.') : null);
  const next = section(detail.title, button(detail.title === 'Current observation' ? 'View recorded replies' : 'Back to replies', 'run-close', { className: 'btn quiet' }), body, undefined, 'insight-section run-detail');
  const heading = next.querySelector('h2')!; heading.tabIndex = -1; heading.dataset.focus = 'run-heading';
  morph(root, box('view', next));
  const select = root.querySelector<HTMLSelectElement>('select'); if (select) select.value = reference;
  if (focus) {
    root.querySelector<HTMLElement>('[data-focus="run-heading"]')?.focus({ preventScroll: true });
    (root.closest('#panel-history')?.querySelector('.secondary-heading') ?? root).scrollIntoView({ block: 'start' });
  }
};
