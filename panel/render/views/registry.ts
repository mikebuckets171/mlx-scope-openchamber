import { html } from '../html.ts';
import { mountCaptures } from './captures.ts';
import { mountHistory } from './history.ts';
import type { MountView, Tab, ViewContext, ViewHandle } from './types.ts';

// Owner: ui-core. The tab views other tracks mount into the shell (docs/2.0/INTERFACES.md §4.5): ui-history's History and
// Captures. The shell passes the frame's own deps (ledger, Next reply); these defaults read storage themselves.

const unavailable = (text: string): MountView => root => {
  root.innerHTML = html`<p class="view-unavailable" role="note">${text}</p>`.markup;
  return { update: () => {}, dispose: () => { root.replaceChildren(); } };
};
export const VIEWS: Record<Extract<Tab, 'history' | 'captures'>, MountView> = {
  history: mountHistory,
  captures: mountCaptures,
};
/** A view that fails to mount leaves an honest note, never a blank tab or a stopped monitor. */
export const mountSafely = (tab: 'history' | 'captures', root: HTMLElement, context: ViewContext, mount: MountView = VIEWS[tab]): ViewHandle => {
  try { return mount(root, context); } catch {
    return unavailable(tab === 'history' ? 'History isn’t available in this build.' : 'Captures aren’t available in this build.')(root, context);
  }
};
