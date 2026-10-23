import { tip } from '../../present/parts.ts';
import type { Block, ServerCard, ServerView } from '../../present/server.ts';
import { html, type Raw } from '../html.ts';
import { chips, meter, tipParts, val, type Open } from './parts.ts';

// The compact server strip inside the Measurement details hub (G2 mock): one quiet line per thing the
// runtime reports, with the engine's identity and detection detail folded into the ⓘ beside its name.

const facts = (card: ServerCard): Raw => html`${card.blocks.flatMap(block => block.kind === 'values'
  ? block.items.map(item => item.label === card.title
    ? html`${val(item.value)}${item.small ? html` <small>${item.small}</small>` : ''}`
    : html`${item.label} ${val(item.value)}${item.small ? html` <small>${item.small}</small>` : ''}`)
  : block.kind === 'list'
    ? block.items.map(item => html`<span class="server-item" data-loaded="${String(item.loaded)}">${item.title}${item.chips.length ? html` ${chips(item.chips)}` : ''}${item.reading.length ? html` <small>${item.reading.join(', ')}</small>` : ''}${item.meter === null ? '' : meter(item.meter, 'margin-top:4px')}</span>`)
    : []).map((part, index) => html`${index ? ' · ' : ''}${part}`)}`;
const gauge = (card: ServerCard): Raw | string => {
  const block = card.blocks.find(item => item.kind === 'meter' || item.kind === 'bar') as Extract<Block, { kind: 'meter' | 'bar' }> | undefined;
  return block ? meter(block.fraction, 'flex:1 1 60px; min-width:60px; margin:0') : '';
};

export const serverMarkup = (view: ServerView, open: Open): Raw => {
  const runtime = view.cards.find(card => card.key === 'runtime');
  if (!runtime) return html``;
  const rows = runtime.blocks.find(block => block.kind === 'kv') as Extract<Block, { kind: 'kv' }> | undefined;
  const kv = rows?.rows ?? [];
  const name = kv.find(row => row.label === 'Server')?.value ?? 'Local server';
  const version = kv.find(row => row.label === 'Version')?.value;
  const detail = kv.filter(row => row.label !== 'Server' && row.label !== 'Version')
    .map(row => row.chips?.length ? `${row.label}: ${row.chips.map(chip => chip.text).join(', ')}` : `${row.label}: ${row.value}`);
  const t = tipParts('server', detail.length ? tip('runtime', 'Engine server detail', detail) : null, open);
  return html`<div class="server-strip" id="server-strip">
    <div class="server-head title-row"><span><strong>${name}</strong>${version ? html` <span translate="no">${version}</span>` : ''}</span>${t.btn}<span class="server-state">${runtime.right}</span></div>
    ${t.pop}
    ${view.cards.filter(card => card.key !== 'runtime').map(card => html`<div class="server-line" data-key="server-${card.key}"><span class="server-label">${card.title}</span><span class="server-facts">${facts(card)}${card.right ? html` · <small class="server-right">${card.right}</small>` : ''}</span>${gauge(card)}</div>`)}</div>`;
};
