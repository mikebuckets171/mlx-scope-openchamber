import type { HostClient } from '@openchamber/sdk';
import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { RuntimeKind } from '../../src/contract/runtime.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import { Signals, type ToastPreference } from '../alerts/signals.ts';
import { Attribution, type TurnView } from '../attribution/controller.ts';
import type { AttributionLabel } from '../attribution/join.ts';
import type { NextReplyState } from '../attribution/next-reply.ts';
import type { FrameSessionState, TurnWindow } from '../attribution/sessions.ts';
import type { TurnSummary } from '../attribution/turn.ts';
import { baselineKey, replyMetric, type Baselines } from '../history/baselines.ts';
import { vsUsual, type RegressionFlag, type VsUsual } from '../history/regress.ts';
import { cofactorBits, KEYS, parseModels, replyRow, turnRowOf, type LedgerAttr } from '../history/ledger-schema.ts';
import { Ledger, LedgerRecorder } from '../history/ledger.ts';
import { RT } from '../present/copy.ts';
import { SERVER_WIDE } from '../present/scope.ts';
import type { ScopeState } from './scope-state.ts';

// Owner: ui-core. The frame's side effects around each poll, wired to the attribution controller, the ledger recorder
// and the signals (INTERFACES §4.2–§4.5): marks and verdicts out, labels and Next reply in, ledger rows and badge/toasts
// from the leader only (P9). Nothing here reaches the DOM; presenters read what it exposes.

type Host = Pick<HostClient, 'onSession' | 'onSessionLifecycle' | 'storage' | 'setBadge' | 'toast'>;
export interface PipelineOptions { host: Host; state: ScopeState; now: () => number; surface: string; toasts: () => ToastPreference; auto: () => boolean }

export const ledgerAttr = (label: AttributionLabel): LedgerAttr => label.kind === 'inferred' ? 'inferred' : label.kind === 'armed' ? 'armed'
  : label.reason === 'not-observed' || label.reason === 'all-requests' ? 'not-observed' : `withheld:${label.reason}`;
/** baseline.v2 changes at most every 10 min (the leader's write), so a frame re-reads it no more often. */
export const USUAL_EVERY_MS = 600_000;
/** Another track's module that throws must not take monitoring down with it. */
const safe = <T>(run: () => T, fallback: T): T => { try { return run(); } catch { return fallback; } };

export class Pipeline {
  readonly attribution: Attribution;
  readonly ledger: Ledger;
  private readonly recorder: LedgerRecorder;
  private readonly signals: Signals;
  private sent: number | undefined;
  private visible = true;
  private turnKey = '';
  flags: readonly RegressionFlag[] = [];
  /** The ledger dictionary's model names (class B), kept out of every share this frame makes. */
  ledgerModels: readonly string[] = [];
  private usual: { baselines: Baselines; models: readonly string[] } | null = null;
  private usualAt = -Infinity;
  constructor(private readonly o: PipelineOptions) {
    this.attribution = new Attribution({ host: o.host, now: o.now, auto: o.auto });
    this.ledger = new Ledger({ storage: o.host.storage, now: o.now });
    this.recorder = new LedgerRecorder(this.ledger, completion => ledgerAttr(this.label(completion)));
    this.signals = new Signals(o.host, o.toasts, o.surface);
  }

  /** `mark` and `attr` for the next poll (pre-encoded comma lists, contract §7). */
  query(): { mark?: string; attr?: string } { return safe(() => this.attribution.query(), {}); }
  /**
   * The `since` this poll sends: the frame's own cursor, held back to the ledger's while this frame records, so a verdict
   * another frame posts still relabels a row (INTERFACES §4.3).
   */
  since(frame: number | undefined): number | undefined {
    const connection = this.o.state.snapshot?.connection.id;
    const ledger = connection === undefined ? undefined : safe(() => this.recorder.since(connection, this.o.now()), undefined);
    this.sent = ledger === undefined ? frame : frame === undefined ? ledger : Math.min(frame, ledger);
    return this.sent;
  }
  /** After a 200: acknowledge what was sent, observe the body, then the leader's signals and ledger. */
  received(snapshot: SnapshotV2, _fresh: readonly CompletionV2[], visible: boolean, cadenceMs = 0): void {
    if (visible && this.o.now() - this.usualAt >= USUAL_EVERY_MS) void this.readUsual();
    safe(() => this.attribution.acknowledge(), undefined);
    safe(() => this.attribution.observe(snapshot, cadenceMs), undefined);
    safe(() => this.signals.apply(snapshot, this.flags), undefined);
    if (snapshot.lease.leader && visible) void this.record(snapshot);
    else void this.recorder.observe({ ...snapshot, lease: { ...snapshot.lease, leader: false } }, this.o.now()).catch(() => {});
  }
  /** A poll without a body: the readings so far no longer run up to now. */
  failed(): void { safe(() => this.attribution.observe(null), undefined); }
  private async record(snapshot: SnapshotV2): Promise<void> {
    try {
      await this.recorder.observe(snapshot, this.o.now(), this.sent);
      this.recordTurn(snapshot);
      if (this.recorder.recording) this.ledgerModels = await this.ledger.models();
    } catch { /* Storage trouble never stops monitoring; the ledger backs off on its own. */ }
  }
  /** baseline.v2 and the model dictionary: two reads, at most every 10 min, only while visible. */
  private async readUsual(): Promise<void> {
    this.usualAt = this.o.now();
    try {
      const [baselines, models] = await Promise.all([this.ledger.storedBaselines(), this.o.host.storage.get(KEYS.models)]);
      this.usual = baselines ? { baselines, models: parseModels(models) } : null;
    } catch { this.usual = null; }
  }
  /**
   * A reply's decode speed against its usual (p50 with n) and the regression flag that covers it, from the stored
   * baselines; null without a baseline for this runtime, model and context bucket.
   */
  usualFor(completion: CompletionV2, runtime: RuntimeKind | null): { vsUsual: VsUsual | null; flag: RegressionFlag | null } {
    const usual = this.usual, index = usual && completion.model ? usual.models.indexOf(completion.model) : -1;
    if (!usual || !runtime || index < 0) return { vsUsual: null, flag: null };
    const row = replyRow(completion, '00000000', runtime, index, 'not-observed'), reading = replyMetric(row, 'decodeTps');
    const key = reading ? baselineKey('decodeTps', reading.key) : null;
    return { vsUsual: safe(() => vsUsual(row, usual.baselines, 'decodeTps'), null), flag: this.flags.find(flag => flag.key === key) ?? null };
  }
  /** A settled, fully attributed turn becomes one `t` row, once. */
  private recordTurn(snapshot: SnapshotV2): void {
    const view = safe(() => this.attribution.turn(), null), summary = view?.summary, rt = snapshot.connection.runtime;
    if (!view || view.live || !summary || !rt || view.window.startedAt === null || view.window.endedAt === null) return;
    const key = `${view.window.tag}\u0000${view.window.startedAt}\u0000${view.window.endedAt}`;
    if (key === this.turnKey) return;
    this.turnKey = key;
    const model = view.steps.find(step => step.model)?.model ?? null;
    this.ledger.appendTurn(turnRowOf({ startedAt: view.window.startedAt, endedAt: view.window.endedAt, rt, modelRef: this.ledger.modelRef(model),
      steps: summary.steps, outputTokens: summary.outputTokens, firstTtftMs: summary.firstTtftMs, decodeTps: summary.decodeTps,
      waitMs: summary.toolMs, attr: ledgerAttr(view.label), cofactors: view.steps.reduce((bits, step) => bits | cofactorBits(step), 0) }));
  }
  /** Visibility gate: a hidden frame cancels Next reply and stops listening; a leader flushes what it holds. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    safe(() => this.attribution.setVisible(visible), undefined);
  }
  /** The frame is going out of view: a leader flushes (hide flushes ≥ 10 s apart, the ledger decides). */
  hidden(): void {
    this.setVisible(false);
    void this.recorder.hidden(this.o.now()).catch(() => {});
  }
  panelMounted(): void { safe(() => this.signals.panelMounted(), undefined); }

  frame(): FrameSessionState { return safe(() => this.attribution.frame(), { connected: false, observedFrom: null, chat: null, windows: [] }); }
  /** A completion's label: this frame's armed step, else the service's recorded verdict, else this frame's own join. */
  label(completion: CompletionV2): AttributionLabel { return safe(() => this.attribution.label(completion), SERVER_WIDE); }
  /** The live reading's label: the join rule applied to the request so far; server-wide while nothing runs. */
  liveLabel(_snapshot: SnapshotV2 | null): AttributionLabel { return safe(() => this.attribution.live(), null) ?? SERVER_WIDE; }
  turnView(): TurnView | null { return safe(() => this.attribution.turn(), null); }
  window(): TurnWindow | null { return this.turnView()?.window ?? this.frame().windows.at(-1) ?? null; }
  /** The open chat's turn summary, only when every step in it is attributed (decision 11). */
  turn(): TurnSummary | null { return this.turnView()?.summary ?? null; }
  /** The open chat's runtime name when it isn't the monitored one ("this chat uses Splash"). */
  chatRuntime(): string | null {
    const provider = this.frame().chat?.provider;
    return provider ? RT[provider as keyof typeof RT] ?? null : null;
  }
  watchable(): string | null { return safe(() => this.attribution.watchable(), null); }
  chatIsLocal(): boolean | null { return safe(() => this.attribution.chatIsLocal(), null); }
  get nextState(): NextReplyState { return safe(() => this.attribution.nextReply, { kind: 'idle' }); }
  arm(_snapshot?: SnapshotV2 | null): void { safe(() => this.attribution.arm(), undefined); }
  cancel(): void { safe(() => this.attribution.cancel(), undefined); }
  get firstRun(): boolean { return safe(() => this.ledger.firstRun, false); }
  get recording(): boolean { return this.recorder.recording; }
  dispose(): void { safe(() => this.attribution.dispose(), undefined); safe(() => this.signals.dispose(), undefined); safe(() => this.recorder.dispose(), undefined); }
}
