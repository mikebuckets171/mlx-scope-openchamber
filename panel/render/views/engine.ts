import type { EngineView } from '../../present/engine.ts';
import { html, type Raw } from '../html.ts';
import { meter } from './parts.ts';

// The Engine room tab (5.5): stateless, rebuilt from each poll like Live. Colours come from the theme tokens in
// style.css; a segment's width is its share of the engine's own budget.

const width = (fraction: number): string => `${Math.max(0, Math.min(100, fraction * 100)).toFixed(2)}%`;

const budgetMarkup = (budget: NonNullable<EngineView['budget']>): Raw => html`
  <p class="engine-big"><strong>${budget.used}</strong> <span>of ${budget.limit} in use</span><span class="engine-free">${budget.free} free</span></p>
  <div class="engine-budget" role="img" aria-label="${`${budget.limit} budget: ${budget.segments.map(segment => `${segment.label} ${segment.key === 'free' ? budget.free : `${(segment.bytes / 2 ** 30).toFixed(1)} GiB`}`).join(', ')}`}">${budget.segments.map(segment =>
    html`<i data-account="${segment.key}" style="flex:${segment.fraction.toFixed(4)}"></i>`)}</div>
  <ul class="engine-legend">${budget.segments.map(segment => html`<li><i class="engine-swatch" data-account="${segment.key}" aria-hidden="true"></i>${segment.label} <strong>${segment.key === 'free' ? budget.free : (segment.bytes / 2 ** 30).toFixed(1)}</strong></li>`)}</ul>`;

const gateMarkup = (view: EngineView): Raw | string => !view.gate && !view.apps ? '' : html`<section class="engine-block" aria-labelledby="engine-gate-title">
  <div class="engine-head"><h3 id="engine-gate-title">Room for another chat</h3>${view.gate ? html`<span class="engine-gate" data-open="${String(view.gate.open)}">${view.gate.text}</span>` : ''}</div>
  ${view.gate ? html`<p class="coverage-note">${view.gate.detail.charAt(0).toUpperCase()}${view.gate.detail.slice(1)}.${view.gate.denied ? ` ${view.gate.denied}` : ''}</p>` : ''}
  ${view.apps ? html`<p class="engine-subhead" title="${view.apps.help}">Holding the most memory${view.apps.since ? html` <small>· growth since ${view.apps.since}</small>` : ''}</p>
  <ul class="engine-apps">${view.apps.rows.map(row => html`<li><span translate="no">${row.name}</span><span class="engine-app-bar" aria-hidden="true"><i style="width:${width(row.fraction)}"></i></span><strong>${row.size}</strong><small>${row.grew ?? ''}</small></li>`)}</ul>` : ''}
</section>`;

export const engineMarkup = (view: EngineView | null): Raw => {
  if (!view) return html`<p class="empty" id="engine-waiting">Waiting for the first reading.</p>`;
  if (view.empty) return html`<p class="empty" id="engine-empty">${view.empty}</p>`;
  return html`<div class="engine-room" id="engine-room">
  ${view.budget ? html`<section class="engine-block" aria-labelledby="engine-budget-title">
    <div class="engine-head"><h3 id="engine-budget-title">Memory budget</h3><span class="engine-meta" translate="no">${view.title}</span></div>
    ${budgetMarkup(view.budget)}
  </section>` : ''}
  ${gateMarkup(view)}
  <section class="engine-block" aria-labelledby="engine-lanes-title">
    <div class="engine-head"><h3 id="engine-lanes-title">Requests</h3><span class="engine-meta">${view.lanes.summary}</span></div>
    ${view.lanes.rows.length ? html`<ul class="engine-lanes">${view.lanes.rows.map(lane => html`<li class="engine-lane" data-tone="${lane.tone}" data-mine="${String(lane.mine)}"><span class="engine-who"><i class="engine-dot" aria-hidden="true"></i>${lane.who}</span><span class="engine-phase">${lane.phase}</span></li>`)}</ul>`
      : html`<p class="coverage-note">No request is running or waiting.</p>`}
  </section>
  ${view.tiles.length ? html`<div class="engine-tiles">${view.tiles.map(tile => html`<div class="engine-tile" data-key="${tile.key}"><span class="metric-label">${tile.label}</span><strong>${tile.value}</strong>${tile.fraction !== undefined ? meter(tile.fraction) : ''}<small>${tile.detail}</small></div>`)}</div>` : ''}
  <p class="engine-stamp">${view.stamp}</p>
</div>`;
};
