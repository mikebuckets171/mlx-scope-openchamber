import { html } from '../html.ts';
import { mountHistory } from './history.ts';
import type { MountView, Tab, ViewContext, ViewHandle } from './types.ts';

// Owner: ui-core. The tab views other tracks mount into the shell (docs/2.0/INTERFACES.md §4.5). History is ui-history's
// `mountHistory`; Captures is ui-history's too, and plugs in here with one line once it exports its mount function.

const unavailable = (text: string): MountView => root => {
  root.innerHTML = html`<p class="view-unavailable" role="note">${text}</p>`.markup;
  return { update: () => {}, dispose: () => { root.replaceChildren(); } };
};
export const VIEWS: Record<Extract<Tab, 'history' | 'captures'>, MountView> = {
  history: mountHistory,
  captures: unavailable('Captures open here: Next reply, 30 or 60 s windows, and up to 12 saved captures. Monitoring keeps running while you capture.'),
};
/** A view that fails to mount leaves an honest note, never a blank tab or a stopped monitor. */
export const mountSafely = (tab: 'history' | 'captures', root: HTMLElement, context: ViewContext): ViewHandle => {
  try { return VIEWS[tab](root, context); } catch {
    return unavailable(tab === 'history' ? 'History isn’t available in this build.' : 'Captures aren’t available in this build.')(root, context);
  }
};
