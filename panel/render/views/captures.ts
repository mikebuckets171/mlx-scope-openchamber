import { version as packageVersion } from '../../../package.json';
import type { SnapshotV2 } from '../../../src/contract/snapshot.ts';
import { CaptureStore, type CaptureV2 } from '../../captures/store.ts';
import { WINDOW_LENGTHS_MS, WindowCapture, type WindowLengthMs } from '../../captures/window.ts';
import { KEYS } from '../../history/ledger-schema.ts';
import { captureFromObservation } from '../../history/migrate-v1.ts';
import { capturesReport, nextReplyCapture, presentCaptures, windowCapture, type CapturesView, type NextCard, type NextReplyControl,
  type SavedRow, type ValueView, type WindowCard } from '../../present/captures-tab.ts';
import type { HistoryText } from '../../present/history.ts';
import { connectionName } from '../../present/messages.ts';
import { box, group, small, span, strong, button, chip, delegate, el, morph, section, seg, svg, Tips, val } from './history-parts.ts';
import type { MountView, ViewContext, ViewHandle } from './types.ts';

// Owner: ui-history. The Captures tab: Next reply, the 30/60 s window and saved captures. Monitoring keeps running
// while it is open or recording (the 1.6 Saved tab suspended it); the frame's polls feed the window through `update`.

export interface CapturesDeps {
  store: Pick<CaptureStore, 'list' | 'save'>;
  /** 1.x captures (`observation.v1.*`), converted for display only; they are never written or deleted here. */
  legacy(): Promise<CaptureV2[]>;
  next: NextReplyControl | null;
  copy(text: string): Promise<void>;
  compose(text: string): Promise<void>;
  version: string;
  /** Model names the frame knows besides the snapshot's (the ledger dictionary), kept out of every share. */
  forbidden?(): readonly string[];
  text?: HistoryText;
}
const TICK_MS = 1_000, NAMES_MAX = 64;

const measure = (): SVGElement => svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, svg('circle', { cx: 8, cy: 8, r: 5.5 }), svg('circle', { cx: 8, cy: 8, r: 1.6 }));
const values = (list: readonly ValueView[], className: string): HTMLElement => box(className, list.map(item => val(item.text, item.basis, item.note)));

const nextCard = (card: NextCard, tips: Tips): HTMLElement => {
  const tip = tips.make('next', 'Next reply', ['Waits up to 2 minutes to measure one reply from this chat’s model.',
    'Cancels if you switch chats, the server stops responding, or Scope becomes hidden or closes. The server and model must match this chat; use Watch to follow another server.']);
  const actions = card.actions.map(item => button(item.action === 'arm' ? [measure(), ` ${item.label}`] : item.label, item.action,
    { className: item.primary ? 'btn primary' : 'btn', focus: `next-${item.action}` }));
  return el('section', { class: 'capture-card', 'data-next': card.state },
    box('section-heading', box('title-row', el('h2', {}, 'Next reply'), tip.btn), card.chip ? el('span', { class: 'title-row' }, chip(card.chip)) : null),
    tip.pop,
    card.result ? [el('div', { class: 'reply-head', style: 'margin-top:6px' }, el('span', { class: 'label' }, 'Last reply'), chip(card.result.chip), el('time', {}, card.result.ago)),
      values(card.result.values, 'reply-values'), values(card.result.split, 'split'), el('p', { class: 'insight-note' }, card.note)]
      : card.state === 'measuring' ? null : el('p', { class: 'insight-note' }, card.note),
    actions.length || card.time ? box('actions',
      card.state === 'measuring' && card.time ? [el('span', { class: 'pulse', 'aria-hidden': 'true' }), el('span', { class: 'insight-note', style: 'margin:0', role: 'status' }, `${card.note} · `,
        el('time', { style: 'color:var(--scope-fg);font-weight:550' }, card.time.value))]
        : card.time ? el('span', { class: 'insight-note', style: 'margin:0' }, el('strong', { style: 'color:var(--scope-fg)' }, card.time.value), card.time.suffix) : null,
      actions) : null);
};
const windowCard = (card: WindowCard, recording: boolean): HTMLElement => el('section', { class: 'capture-card', 'data-window': card.status },
  box('section-heading', el('h2', {}, 'Timed recording'), span( card.state)),
  el('p', { class: 'insight-note' }, 'Averages all server activity for 30 or 60 seconds.'),
  card.progress !== null ? el('div', { class: 'progress-track', role: 'progressbar', 'aria-label': 'Recording progress', 'aria-valuemin': 0, 'aria-valuemax': 100,
    'aria-valuenow': Math.floor(card.progress), style: 'margin-top:12px' }, el('span', { style: `width:${card.progress.toFixed(1)}%` })) : null,
  card.values.length ? values(card.values, 'reply-values') : null,
  box('actions', recording ? button('Stop', 'window-stop')
    : card.status === 'idle' ? [el('select', { class: 'btn', 'aria-label': 'Recording length', 'data-action': 'window-length', 'data-focus': 'window-length' },
      WINDOW_LENGTHS_MS.map(ms => el('option', { value: ms, selected: ms === card.lengthMs }, `${ms / 1000} s`))), button('Start capture', 'window-start')]
      : [card.canSave ? button('Save to Captures', 'window-save') : null, button('Discard', 'window-discard')]),
  el('p', { class: 'notice', style: 'margin-top:12px' }, 'Monitoring keeps running while you capture.'));
const savedRow = (row: SavedRow): HTMLElement => el('li', { class: 'led-row' }, el('time', { datetime: row.iso }, row.at),
  box('led-main', row.rate ? val(strong( row.rate.text), row.rate.basis, row.rate.note) : strong( 'No output speed'),
    span( row.title), chip(row.chip), row.delta ? el('span', { class: 'chip', 'data-basis': 'derived' }, row.delta.text) : null,
    button(row.comparing ? 'Comparing' : 'Compare', 'compare', { className: 'btn quiet', arg: row.key, focus: `compare-${row.key}` })));

class CapturesViewHandle implements ViewHandle {
  private snapshot: SnapshotV2 | null = null;
  private readonly window = new WindowCapture();
  private windowLength: WindowLengthMs = 60_000;
  private method: 'reply' | 'window' = 'reply';
  private saved: CaptureV2[] = [];
  private legacy: CaptureV2[] = [];
  private reference: string | null = null;
  private nextSaved: number | null = null;
  private session = false;
  private status = '';
  private readonly names = new Set<string>();
  private readonly tips: Tips;
  private readonly undelegate: () => void;
  private readonly unsession: () => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private view: CapturesView | null = null;

  constructor(private readonly root: HTMLElement, private readonly context: ViewContext, private readonly deps: CapturesDeps) {
    this.tips = new Tips(`captures-${Math.random().toString(36).slice(2, 8)}`);
    this.undelegate = delegate(root, (action, arg, target) => void this.act(action, arg, target));
    this.unsession = context.host.onSession(session => { this.session = session !== null; this.render(); });
    void this.load();
    this.render();
  }
  update(snapshot: SnapshotV2 | null): void {
    if (this.disposed) return;
    this.snapshot = snapshot;
    if (snapshot) {
      this.window.observe(snapshot);
      const r = snapshot.runtime;
      for (const name of [r.request?.model, ...r.residency.map(m => m.model), ...r.catalog.map(m => m.name)]) if (name && this.names.size < NAMES_MAX) this.names.add(name);
    }
    this.render();
  }
  activate(): void { void this.load(); }
  captureActivity(): string | null {
    const capture = this.window.current;
    if (!capture || !this.window.recording) return null;
    const remaining = Math.ceil(Math.max(0, capture.targetMs - (this.context.now() - capture.startedAt)) / 1_000);
    return `Timed recording · ${remaining} s left`;
  }
  cancelCapture(): void { this.window.stop(); this.render(); }
  dispose(): void {
    this.disposed = true; this.undelegate(); this.unsession();
    if (this.timer !== null) clearTimeout(this.timer);
    // Next reply belongs to the frame (it also shows on Live), so only the window, which this view feeds, stops here.
    this.window.stop('This view closed');
    this.root.replaceChildren();
  }

  private async load(): Promise<void> {
    const [saved, legacy] = await Promise.all([this.deps.store.list().catch(() => null), this.deps.legacy().catch(() => [])]);
    if (this.disposed) return;
    if (saved) {
      this.saved = saved;
      if (this.status === 'Saved captures couldn’t be read. Monitoring still works.') this.status = '';
    } else this.status = 'Saved captures couldn’t be read. Monitoring still works.';
    this.legacy = legacy;
    this.render();
  }
  private forbidden(): string[] { return [...this.names, ...this.deps.forbidden?.() ?? []]; }
  private async act(action: string, arg: string, target: HTMLElement): Promise<void> {
    const next = this.deps.next, state = next?.state();
    if (action === 'tip') this.tips.toggle(arg);
    else if (action === 'capture-method') this.method = arg === 'window' ? 'window' : 'reply';
    else if (action === 'arm') next?.arm();
    else if (action === 'cancel') next?.cancel();
    else if (action === 'watch') next?.watch?.();
    else if (action === 'window-length') this.windowLength = Number((target as HTMLSelectElement).value) === 30_000 ? 30_000 : 60_000;
    else if (action === 'window-start') {
      if (!this.snapshot || !this.window.start(this.snapshot, this.windowLength)) this.status = 'Wait for a fresh server reading, then start recording.';
      else this.status = '';
    } else if (action === 'window-stop') this.window.stop();
    else if (action === 'window-discard') this.window.clear();
    else if (action === 'compare') this.reference = this.reference === arg ? null : arg;
    else if (action === 'save-next' && state?.kind === 'result') {
      await this.save(nextReplyCapture(state, this.snapshot?.connection.runtime ?? null, this.context.now()), () => { this.nextSaved = state.endedAt; });
    } else if (action === 'window-save' && this.window.current) {
      await this.save(windowCapture(this.window.current, this.context.now()), () => this.window.clear());
    } else if (action === 'copy' || action === 'compose') {
      const text = capturesReport(this.saved, this.deps.version, this.forbidden());
      try {
        await (action === 'copy' ? this.deps.copy(text) : this.deps.compose(text));
        this.status = action === 'copy' ? 'Captures copied without model names.' : 'Captures added to the chat draft without model names.';
      } catch { this.status = action === 'copy' ? 'Couldn’t copy: the clipboard wasn’t confirmed.' : 'Couldn’t add to the chat draft.'; }
    } else return;
    this.render();
  }
  private async save(capture: CaptureV2, done: () => void): Promise<void> {
    try {
      await this.deps.store.save(capture); done();
      this.saved = await this.deps.store.list();
      this.status = 'Saved to Captures without model names.';
    } catch { this.status = 'Couldn’t save the capture. Nothing was confirmed saved.'; }
  }
  private render(): void {
    if (this.disposed) return;
    const s = this.snapshot, runtime = s?.connection.runtime ?? null, next = this.deps.next?.state() ?? null;
    const view = presentCaptures({
      now: this.context.now(), runtime, runtimeName: runtime ? connectionName(runtime, { engine: s!.connection.engine ?? null, host: s!.connection.host ?? null }) : 'The server',
      completions: !!s?.capabilities['server.completions'], paused: false, next, nextSaved: next?.kind === 'result' && next.endedAt === this.nextSaved,
      window: this.window.current, windowLength: this.windowLength, saved: this.saved, legacy: this.legacy, reference: this.reference,
      ...this.deps.text ? { text: this.deps.text } : {},
    });
    this.view = view;
    const nextActive = view.next.state === 'armed' || view.next.state === 'measuring';
    const methods = box('capture-methods', seg('Capture method', 'capture-method', [
      { label: 'Reply', arg: 'reply', pressed: this.method === 'reply' },
      { label: 'Timed recording', arg: 'window', pressed: this.method === 'window' },
    ]));
    const tree = group( methods,
      // Switching the method never clears a running capture or hides its cancellation control.
      this.method === 'reply' || nextActive ? nextCard(view.next, this.tips) : null,
      this.method === 'window' || this.window.recording ? windowCard(view.window, this.window.recording) : null,
      this.method !== 'reply' && view.next.state === 'result' ? el('p', { class: 'capture-ready', role: 'status' }, 'Reply measurement ready. ', button('View reply', 'capture-method', { arg: 'reply', className: 'btn quiet' })) : null,
      this.method !== 'window' && this.window.current && !this.window.recording ? el('p', { class: 'capture-ready', role: 'status' }, `Timed recording: ${view.window.state}. `, button('View timed recording', 'capture-method', { arg: 'window', className: 'btn quiet' })) : null,
      section('Saved', view.saved.right, [view.saved.empty ? el('p', { class: 'empty' }, view.saved.empty) : el('ol', { class: 'ledger' }, view.saved.rows.map(savedRow)),
        box('actions', button('Copy', 'copy', { disabled: !view.saved.share }),
          button('Add to chat draft', 'compose', { disabled: !view.saved.share || !this.session }),
          el('span', { class: 'insight-note', style: 'margin:0' }, 'Never includes model names')),
        this.status ? el('p', { class: 'insight-note', role: 'status' }, this.status) : null]),
      view.legacy ? section('Saved in 1.x', view.legacy.right, el('ol', { class: 'ledger' }, view.legacy.rows.map(savedRow)),
        this.tips.make('legacy', 'Saved in 1.x', ['Original 1.x captures, untouched through 2.0.x; removed in 2.1.'])) : null);
    morph(this.root, tree);
    const select = this.root.querySelector<HTMLSelectElement>('select[data-action="window-length"]');
    if (select) select.value = String(this.windowLength);
    this.tick();
  }
  /** Armed and measuring count in seconds; a timer runs only for them, and only while the view can be seen. */
  private tick(): void {
    const kind = this.view?.next.state;
    if (this.timer !== null || this.disposed || !(kind === 'armed' || kind === 'measuring') || !this.context.visible()) return;
    this.timer = setTimeout(() => { this.timer = null; this.render(); }, TICK_MS);
  }
}

export const capturesView = (deps: CapturesDeps): MountView => (root, context) => new CapturesViewHandle(root, context, deps);

/** 1.x captures straight from `observation.v1.*`: read-only, converted by the ledger's migration code. */
export const readLegacyCaptures = async (storage: ViewContext['host']['storage']): Promise<CaptureV2[]> => {
  const keys = (await storage.keys()).filter(key => key.startsWith(KEYS.legacyObservationPrefix));
  const items = await Promise.all(keys.map(async key => captureFromObservation(await storage.get(key))));
  return items.filter((item): item is CaptureV2 => item !== null);
};
export const defaultCapturesDeps = (context: ViewContext): CapturesDeps => ({
  store: new CaptureStore(context.host.storage), legacy: () => readLegacyCaptures(context.host.storage), next: null,
  copy: text => context.host.writeClipboard(text), compose: text => context.host.compose({ text, mode: 'append' }), version: packageVersion,
});
export const mountCaptures: MountView = (root, context) => capturesView(defaultCapturesDeps(context))(root, context);
