import { version as packageVersion } from '../../../package.json';
import type { SnapshotV2 } from '../../../src/contract/snapshot.ts';
import type { TrendV2, TrendWindowMs } from '../../../src/contract/trend.ts';
import type { UsageRange, UsageV2 } from '../../../src/contract/usage.ts';
import { HistoryClient, type HistoryResult } from '../../data/history.ts';
import { buildBaselines, type Baselines } from '../../history/baselines.ts';
import { KEYS, type LedgerRow, type ReplyRow } from '../../history/ledger-schema.ts';
import { Ledger, RETENTION_DAYS } from '../../history/ledger.ts';
import { RegressionTracker, type RegressionFlag } from '../../history/regress.ts';
import { baselineSummary } from '../../history/summary.ts';
import { HISTORY_LIST_LIMIT, HISTORY_LIST_STEP, presentHistory, type BaselineCard, type HistoryEntry, type HistoryText, type HistoryView, type TrendCard } from '../../present/history.ts';
import { connectionName } from '../../present/messages.ts';
import { box, group, small, span, strong, button, chip, delegate, el, focusKey, morph, section, seg, svg, Tips, val, type Child } from './history-parts.ts';
import type { MountView, ViewContext, ViewHandle } from './types.ts';

// Owner: ui-history. The History tab and the page's History column.

/** What the view reads and changes. The shell should pass the frame's one Ledger, so unflushed rows show too. */
export interface HistoryDeps {
  ledger: Pick<Ledger, 'state' | 'read' | 'models' | 'accounting' | 'setRetention' | 'setPaused' | 'clear'>;
  client: Pick<HistoryClient, 'trend' | 'usage'>;
  retentionDays(): number;                   // pref.v2
  paused(): boolean;                         // pref.v2: shown until this frame's ledger runs, which then decides
  copy(text: string): Promise<void>;
  version: string;
  /** The same provider/runtime the frame's snapshot poll uses; default: the snapshot's connection id. */
  selection?(snapshot: SnapshotV2 | null): { provider?: string; runtime?: string };
  legacyCaptures?(): Promise<number>;        // "Your 1.6 captures are in Captures"
  flags?(flags: readonly RegressionFlag[]): void;   // for panel/alerts/signals.ts
  text?: HistoryText;
}
// Each storage read makes the host re-read the whole namespace file (S5): the ledger is read on mount, after a new
// reply (at most every 5 s) and otherwise only as often as another frame can flush (5 min).
const TREND_MIN_MS = 5_000, USAGE_EVERY_MS = 300_000, READ_MIN_MS = 5_000, READ_EVERY_MS = 300_000;
const REASON: Readonly<Record<string, string>> = {
  not_served: 'The trend isn’t served by this version of the service yet.', contract_mismatch: 'The trend needs the updated service. Pause and resume MLX Scope in Settings → Extensions.',
  unparseable: 'The trend arrived in a shape Scope doesn’t know, so it isn’t shown.',
};
const GRID = 'M4 4H596 M4 60H596 M4 116H596';

// ---------- parts ----------
const trendFigure = (card: TrendCard, page: boolean): HTMLElement => {
  const g = card.geometry, showPlot = !!g || card.gaps.length > 0 && !card.empty;
  return el('figure', { class: 'signal trend' },
    box('chart-top', span( card.title), span( card.ceiling ?? '')),
    showPlot ? el('div', { class: 'plot', role: 'img', 'aria-label': card.summary },
      svg('svg', { viewBox: '0 0 600 120', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
        svg('path', { class: 'grid', d: GRID }),
        g ? [svg('path', { class: 'band', d: g.band.join(' ') }), svg('path', { class: 'trace', d: g.segments.join(' ') }),
          g.spans.map(span => svg('rect', { class: 'turn-span', x: span.x.toFixed(1), y: 117, width: span.width.toFixed(1), height: 3 })),
          g.marks.filter(mark => mark.phase === 'started').map(mark => svg('line', { class: 'mark', x1: mark.x.toFixed(1), x2: mark.x.toFixed(1), y1: 4, y2: 116 }))] : null),
      card.gaps.map(gap => el('div', { class: 'gap-band', 'aria-hidden': 'true', style: `left:${gap.left};width:${gap.width}` }, span( 'Not observed · Scope wasn’t open'))))
      : el('p', { class: 'chart-wait' }, card.empty ?? ''),
    showPlot ? [el('figcaption', {}, span( card.from), span( page ? card.note : ''), span( 'now')),
      page ? null : el('p', { class: 'insight-note' }, card.note),
      box('legend', span( el('i'), 'last reading · shaded min–max'), span( el('i', { class: 'tick' }), 'this chat’s turns'),
        span( el('i', { class: 'hatch' }), 'not observed'))] : null);
};
const entryRow = (entry: HistoryEntry): HTMLElement => {
  if (entry.kind === 'gap') return el('li', { class: 'led-row', 'data-kind': 'gap' }, box('gap-row', span( entry.text)));
  if (entry.kind === 'turn') return el('li', { class: 'led-row', 'data-kind': 't' }, el('time', { datetime: entry.iso }, entry.at),
    box('led-main', strong( entry.title), entry.time && val(entry.time, 'observed', 'observed · waits excluded'),
      entry.rate && val(entry.rate, 'derived', 'derived'), span( entry.detail), chip(entry.attr)));
  return el('li', { class: 'led-row' }, el('time', { datetime: entry.iso }, entry.at),
    box('led-main', val(strong( entry.rate ?? entry.output ?? 'No speed reported'), entry.basis, entry.basisLabel),
      entry.detail ? span( entry.detail) : null, entry.ttft ? span( entry.ttft) : null,
      entry.model ? el('span', { translate: 'no' }, entry.model) : null, chip(entry.attr)));
};
const baselineBody = (card: BaselineCard, tips: Tips, status: string): Child => {
  const flagTip = card.flag && tips.make('baseline-flag', 'Slower than usual', card.flag.tip);
  return [
    card.empty ? el('p', { class: 'empty' }, card.empty)
      : box('values-3', card.tiles.map(tile => group( span( tile.label), strong( tile.value), small( tile.detail)))),
    card.flag && flagTip ? [el('div', { class: 'chips', style: 'margin-top:10px' }, el('span', { class: 'chip', 'data-tone': 'warn', 'data-basis': 'derived' }, card.flag.chip), flagTip.btn), flagTip.pop] : null,
    !card.empty && card.rows.length ? el('dl', { class: 'kv' }, card.rows.map(row => group( el('dt', {}, row.label),
      el('dd', {}, row.basis ? val(row.value, 'estimate', row.basis) : row.value)))) : null,
    card.copy ? box('actions', button('Copy baseline summary', 'copy-baselines'),
      el('span', { class: 'insight-note', style: 'margin:0' }, 'Models become “Model A, B”')) : null,
    status ? el('p', { class: 'insight-note', role: 'status' }, status) : null,
  ];
};
const storageSection = (view: NonNullable<HistoryView['storage']>, tips: Tips, prefix: string, status: string): HTMLElement => {
  const tip = tips.make('storage', 'Reply history', ['Local OpenChamber storage, included in backups. Model names stay on this Mac.',
    'The recording Scope view saves at most every 5 min or when hidden, never while idle.']);
  const confirm = view.confirm;
  return el('section', { class: 'insight-section storage', 'data-full': String(!!view.full) },
    box('section-heading', box('title-row', el('h2', {}, 'Reply history'), tip.btn),
      span( view.paused ? el('span', { class: 'chip', 'data-tone': 'warn' }, view.label) : view.label)),
    tip.pop,
    view.full ? el('div', { class: 'connection-diagnosis', 'data-severity': 'warning', role: 'status' },
      el('p', { class: 'diag-title' }, el('span', { class: 'sr-only' }, 'Warning: '), strong( 'History is full')), el('p', { class: 'diag-meta' }, view.full)) : null,
    view.note ? el('p', { class: 'notice', style: 'margin-top:10px' }, view.note) : null,
    confirm ? el('div', { class: 'connection-diagnosis', 'data-severity': 'critical', role: 'alertdialog', 'aria-labelledby': `${prefix}-clear-title`, 'aria-describedby': `${prefix}-clear-detail` },
      el('p', { class: 'diag-title' }, el('strong', { id: `${prefix}-clear-title` }, confirm.title)), el('p', { class: 'diag-meta', id: `${prefix}-clear-detail` }, confirm.detail),
      box('actions', button('Clear history', 'clear-confirm', { className: 'btn danger' }), button('Cancel', 'clear-cancel')))
      : [box('storage-line', strong( view.used), span( view.detail)),
        view.meter ? el('div', { class: 'meter', 'aria-hidden': 'true' }, el('i', { style: `width:${(view.fraction * 100).toFixed(1)}%` })) : null,
        box('storage-controls',
          el('label', {}, 'Keep ', el('select', { class: 'btn', 'data-action': 'retention', 'data-focus': 'retention', 'aria-label': 'Keep reply history for' },
            view.options.map(days => el('option', { value: days, selected: days === view.retentionDays }, `${days} days`)))),
          button(view.paused ? 'Resume recording' : 'Pause recording', 'pause'), button('Clear…', 'clear'))],
    status ? el('p', { class: 'insight-note', role: 'status' }, status) : null);
};

// ---------- the view ----------
class HistoryViewHandle implements ViewHandle {
  private snapshot: SnapshotV2 | null = null;
  private rows: LedgerRow[] = [];
  private models: readonly string[] = [];
  private baselines: Baselines = new Map();
  private readonly regressions = new RegressionTracker();
  private trend: TrendV2 | null = null;
  private trendError: string | null = null;
  private windowMs: TrendWindowMs = 3_600_000;
  private usage: UsageV2 | null = null;
  private usageRange: UsageRange = '7d';
  private retention: number;
  private paused: boolean;
  private confirm = false;
  private legacy = 0;
  private listLimit = HISTORY_LIST_LIMIT;
  private status = { baseline: '', storage: '' };
  private readonly tips: Tips;
  private readonly prefix: string;
  private readonly undelegate: () => void;
  private trendAt = -Infinity; private usageAt = -Infinity; private readAt = -Infinity;
  private cursor = '';
  private reads = 0;                         // bumped by Clear, so a read that started before it is dropped
  private busy = { trend: false, usage: false, read: false };
  private focus: string | null = null;
  private disposed = false;
  private stamp = '';                       // what of the snapshot this view shows; a poll that changes none of it renders nothing

  constructor(private readonly root: HTMLElement, private readonly context: ViewContext, private readonly deps: HistoryDeps) {
    this.prefix = `history-${Math.random().toString(36).slice(2, 8)}`;
    this.tips = new Tips(this.prefix);
    this.retention = deps.retentionDays();
    this.paused = deps.paused();
    this.undelegate = delegate(root, (action, arg, target) => void this.act(action, arg, target));
    root.addEventListener('keydown', this.escape);
    void deps.legacyCaptures?.().then(count => { this.legacy = count; this.render(); }).catch(() => {});
    this.render();
    this.refresh();
  }
  update(snapshot: SnapshotV2 | null): void {
    if (this.disposed) return;
    const connection = (s: SnapshotV2 | null) => s ? `${s.connection.id}|${s.connection.runtime}` : '';
    // Another connection has another trend and usage: drop what was read for the previous one.
    if (connection(snapshot) !== connection(this.snapshot)) { this.trend = null; this.usage = null; this.trendAt = this.usageAt = -Infinity; }
    this.snapshot = snapshot;
    // A running ledger holds the stored pause (it re-reads pref.v2 at start and on each flush); a stopped one keeps
    // what this view shows (the stored pref, or the user's own toggle).
    const state = this.deps.ledger.state;
    if (state !== 'stopped') this.paused = state === 'paused';
    this.refresh();
    // Polls come up to twice a second; the view only needs the connection, alert log, pause state and the minute (clock labels).
    const s = snapshot, stamp = JSON.stringify([connection(s), s?.connection.engine, s?.connection.host, !!s?.capabilities['server.usage'],
      s?.runtime.request?.model ?? s?.runtime.residency[0]?.model, s?.alertLog, this.paused, Math.floor(this.context.now() / 60_000)]);
    if (stamp !== this.stamp) { this.stamp = stamp; this.render(); }
  }
  dispose(): void {
    this.disposed = true; this.undelegate(); this.root.removeEventListener('keydown', this.escape); this.root.replaceChildren();
  }

  private readonly escape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.confirm) { event.preventDefault(); this.confirm = false; this.focus = 'clear'; this.render(); }
  };
  /** Reads only while the view can be seen; each source at its own pace, never two at once. */
  private refresh(): void {
    if (this.disposed || !this.context.visible()) return;
    const now = this.context.now(), completions = this.snapshot?.completions, cursor = completions ? `${completions.instance}.${completions.cursor}` : '';
    if (now - this.trendAt >= Math.max(TREND_MIN_MS, this.windowMs / 180)) void this.readTrend();
    if (this.snapshot?.capabilities['server.usage'] && now - this.usageAt >= USAGE_EVERY_MS) void this.readUsage();
    if (now - this.readAt >= READ_EVERY_MS || cursor !== this.cursor && now - this.readAt >= READ_MIN_MS) { this.cursor = cursor; void this.readLedger(); }
  }
  private query(): { provider?: string; runtime?: string } {
    if (this.deps.selection) return this.deps.selection(this.snapshot);
    const id = this.snapshot?.connection.id;
    return id && id !== 'auto' ? { provider: id } : {};
  }
  private async readTrend(): Promise<void> {
    if (this.busy.trend) return;
    this.busy.trend = true; this.trendAt = this.context.now();
    const windowMs = this.windowMs;
    const result: HistoryResult<TrendV2> = await this.deps.client.trend({ ...this.query(), windowMs, series: ['decodeTps'] })
      .catch(() => ({ ok: false as const, reason: 'host_unavailable' as const })).finally(() => { this.busy.trend = false; });
    if (this.disposed || windowMs !== this.windowMs) return;
    this.trend = result.ok ? result.body : this.trend?.windowMs === windowMs ? this.trend : null;
    this.trendError = result.ok ? null : REASON[result.reason] ?? 'The trend couldn’t be read. Scope tries again shortly.';
    this.render();
  }
  private async readUsage(): Promise<void> {
    if (this.busy.usage) return;
    this.busy.usage = true; this.usageAt = this.context.now();
    const range = this.usageRange, result: HistoryResult<UsageV2> = await this.deps.client.usage({ ...this.query(), range })
      .catch(() => ({ ok: false as const, reason: 'host_unavailable' as const })).finally(() => { this.busy.usage = false; });
    if (this.disposed || range !== this.usageRange) return;
    // The card hides when oMLX can't give its records (401, 404, 503) rather than showing an error.
    this.usage = result.ok ? result.body : null;
    this.render();
  }
  private async readLedger(): Promise<void> {
    if (this.busy.read) return;
    this.busy.read = true; this.readAt = this.context.now();
    const reads = this.reads;
    try {
      const [rows, models] = await Promise.all([this.deps.ledger.read(), this.deps.ledger.models()]);
      if (this.disposed || reads !== this.reads) return;
      const now = this.context.now();
      this.rows = rows; this.models = models;
      const replies = rows.filter((row): row is ReplyRow => row[0] === 'r');
      this.baselines = buildBaselines(replies, now);
      this.deps.flags?.(this.regressions.update(replies, this.baselines, now));
      this.render();
    } catch { /* Storage can refuse a read; the last rows stay until the next one succeeds. */ }
    finally { this.busy.read = false; }
  }
  private async act(action: string, arg: string, target: HTMLElement): Promise<void> {
    if (action === 'tip') { this.tips.toggle(arg); this.focus = null; }
    else if (action === 'window') { this.windowMs = Number(arg) as TrendWindowMs; this.trend = this.trend?.windowMs === this.windowMs ? this.trend : null; this.trendAt = -Infinity; }
    else if (action === 'range') { this.usageRange = arg as UsageRange; this.usageAt = -Infinity; }
    else if (action === 'more') { this.listLimit += HISTORY_LIST_STEP; this.focus = 'more'; }
    else if (action === 'clear') { this.confirm = true; this.focus = 'clear-cancel'; }
    else if (action === 'clear-cancel') { this.confirm = false; this.focus = 'clear'; }
    else if (action === 'copy-baselines') {
      try {
        await this.deps.copy(baselineSummary(this.baselines, this.models, this.deps.version, this.context.now()));
        this.status.baseline = 'Baseline summary copied, with models as “Model A, B”.';
      } catch { this.status.baseline = 'Couldn’t copy the summary: the clipboard wasn’t confirmed.'; }
    } else if (action === 'pause') {
      this.paused = !this.paused; this.deps.ledger.setPaused(this.paused);
      this.status.storage = this.paused ? 'Recording paused. Replies that finish now aren’t kept.' : 'Recording again.';
    } else if (action === 'retention') {
      const days = Number((target as HTMLSelectElement).value);
      if (!Number.isInteger(days) || days < 1 || days > RETENTION_DAYS.max) return;
      this.retention = days;
      try { await this.deps.ledger.setRetention(days); this.status.storage = `Keeping ${days} days. Older replies go at the next save.`; }
      catch { this.status.storage = 'Couldn’t save the new retention. Nothing was removed.'; }
    } else if (action === 'clear-confirm') {
      this.confirm = false; this.focus = 'clear'; this.reads += 1;
      try {
        await this.deps.ledger.clear();
        this.rows = []; this.baselines = new Map(); this.regressions.clear(); this.deps.flags?.([]);
        this.status.storage = 'Reply history and baselines cleared. Captures were kept.';
      } catch { this.status.storage = 'Couldn’t clear the history. Nothing was confirmed removed.'; }
      this.readAt = -Infinity;
    } else return;
    this.render();
    this.refresh();
  }

  private view(): HistoryView {
    const s = this.snapshot, runtime = s?.connection.runtime ?? null;
    return presentHistory({
      now: this.context.now(), trend: this.trend, rows: this.rows, models: this.models, baselines: this.baselines, flags: this.regressions.current,
      usage: s?.capabilities['server.usage'] ? this.usage : null, storage: this.deps.ledger.accounting(), paused: this.paused, retentionDays: this.retention,
      alertLog: s?.alertLog ?? [], runtimeName: runtime ? connectionName(runtime, { engine: s!.connection.engine ?? null, host: s!.connection.host ?? null }) : undefined,
      model: s?.runtime.request?.model ?? s?.runtime.residency[0]?.model ?? null, windowMs: this.windowMs, usageRange: this.usageRange, trendError: this.trendError,
      confirmClear: this.confirm, listLimit: this.listLimit, recording: this.deps.ledger.state === 'backoff' ? 'backoff' : 'recording', legacyCaptures: this.legacy,
      ...this.deps.text ? { text: this.deps.text } : {},
    });
  }
  private render(): void {
    if (this.disposed) return;
    const view = this.view(), page = this.context.surface === 'page';
    const tips = this.tips, tip = (name: string, title: string, paras: readonly string[]) => tips.make(name, title, paras);
    const trend = section('Trend', seg('Trend window', 'window', view.trend.windows.map(w => ({ label: w.label, arg: String(w.windowMs), pressed: w.pressed }))),
      trendFigure(view.trend, page), tip('trend', 'Trend', view.trend.tip), page ? 'insight-section history-trend' : 'insight-section');
    const replies = section('Recent replies', view.header, view.repliesEmpty ? el('p', { class: 'empty' }, view.repliesEmpty) : [
        box('counts', view.counts.map(text => el('span', { class: 'chip' }, text))),
        el('ol', { class: 'ledger' }, view.entries.map(entryRow)),
        view.more ? box('actions', el('span', { class: 'insight-note', style: 'margin:0' }, view.more),
          view.showMore ? button(view.showMore, 'more', { className: 'btn quiet' }) : null) : null], tip('replies', 'Replies', view.repliesTip),
      page ? 'insight-section recent-replies' : 'insight-section');
    const storage = view.storage ? storageSection(view.storage, tips, this.prefix, this.status.storage) : null;
    // Keep the native disclosure's state across polling morphs. Warnings and confirmation remain visible.
    const storageOpen = this.root.querySelector<HTMLDetailsElement>('.history-storage')?.open ?? false;
    const storageNeedsAttention = !!view.storage?.full || !!view.storage?.note || !!view.storage?.confirm;
    const storageDetails = storage && view.storage ? el('details', {
      class: 'history-storage', open: storageOpen || storageNeedsAttention, 'data-attention': String(storageNeedsAttention),
    }, el('summary', { 'data-focus': 'history-storage' }, span( 'History storage'),
      el('span', { class: 'history-storage-state', 'data-paused': String(view.storage.paused) },
        storageNeedsAttention ? 'Needs attention' : view.storage.label)), storage) : storage;
    const baseline = section('Usual speed', view.baseline.model || view.baseline.bucket ? [view.baseline.model ? el('span', { translate: 'no' }, view.baseline.model) : null,
        view.baseline.model && view.baseline.bucket ? ' · ' : null, view.baseline.bucket] : null, baselineBody(view.baseline, tips, this.status.baseline),
      tip('baseline', 'Usual speed', view.baseline.tip), 'insight-section history-baseline');
    const usage = view.usage ? section(view.usage.title, seg('Usage range', 'range', view.usage.ranges.map(r => ({ label: r.label, arg: r.label, pressed: r.pressed }))), [
        el('div', { class: 'usage-bars', role: 'img', 'aria-label': view.usage.aria, 'data-dense': view.usage.dense, style: `grid-template-columns:repeat(${view.usage.bars.length},minmax(0,1fr))` },
          view.usage.bars.map(bar => el('div', { 'aria-hidden': 'true' }, el('i', { style: `height:${bar.height}px` })))),
        el('div', { class: 'usage-days', 'aria-hidden': 'true', 'data-dense': view.usage.dense, style: `grid-template-columns:repeat(${view.usage.bars.length},minmax(0,1fr))` },
          view.usage.bars.map(bar => span( bar.label))),
        box('values-3', view.usage.rows.map(row => group( span( row.label), strong( row.value), row.detail ? small( row.detail) : null)))],
      tip('usage', view.usage.title, view.usage.tip)) : null;
    const alertLog = section('Alert log', 'Last 20 · while Scope was open', view.alertLogEmpty ? el('p', { class: 'empty' }, view.alertLogEmpty)
        : el('ol', { class: 'alog' }, view.alertLog.map(entry => el('li', {}, el('time', { datetime: entry.iso }, entry.at),
          span( el('i', { class: 'sev', 'data-severity': entry.severity, 'aria-hidden': 'true' }), el('span', { class: 'sr-only' }, `${entry.severityWord}: `), entry.text),
          small( entry.duration)))),
      tip('alog', 'Alert log', ['Kept in the service’s memory only, so it clears when the service restarts.']));
    const insightsAttention = !!view.baseline.flag;
    const insights = el('details', { class: 'history-insights', 'data-attention': String(insightsAttention),
      open: this.root.querySelector<HTMLDetailsElement>('.history-insights')?.open || insightsAttention },
      el('summary', {}, span( 'Insights'), el('span', { class: 'history-storage-state' }, insightsAttention ? 'Slower than usual' : 'Baselines & usage')),
      group( baseline, usage));
    const alertsAttention = this.snapshot?.alerts.some(alert => alert.severity !== 'info') ?? false;
    const alerts = el('details', { class: 'history-alerts', 'data-attention': String(alertsAttention),
      open: this.root.querySelector<HTMLDetailsElement>('.history-alerts')?.open || alertsAttention },
      el('summary', {}, span( 'Alert log'), el('span', { class: 'history-storage-state' }, alertsAttention ? 'Needs attention' : `${view.alertLog.length} recorded`)), alertLog);
    const next = group( trend, replies, insights, alerts, storageDetails);
    morph(this.root, next);
    const select = this.root.querySelector<HTMLSelectElement>('select[data-action="retention"]');
    if (select) select.value = String(this.retention);
    focusKey(this.root, this.focus); this.focus = null;
  }
}

export const historyView = (deps: HistoryDeps): MountView => (root, context) => new HistoryViewHandle(root, context, deps);

/** Without an injected ledger the view reads storage itself; unflushed rows of the frame's own ledger are then missing. */
export const defaultHistoryDeps = (context: ViewContext): HistoryDeps => ({
  ledger: new Ledger({ storage: context.host.storage, now: context.now }), client: new HistoryClient(context.host),
  retentionDays: () => RETENTION_DAYS.default, paused: () => false, copy: text => context.host.writeClipboard(text), version: packageVersion,
  legacyCaptures: async () => (await context.host.storage.keys()).filter(key => key.startsWith(KEYS.legacyObservationPrefix)).length,
});

export const mountHistory: MountView = (root, context) => historyView(defaultHistoryDeps(context))(root, context);
