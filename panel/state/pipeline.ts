import type { HostClient } from '@openchamber/sdk';
import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import { Signals, type ToastPreference } from '../alerts/signals.ts';
import { join, labelOf, type AttributionLabel, type JoinContext } from '../attribution/join.ts';
import { NextReply, type NextReplyState } from '../attribution/next-reply.ts';
import { SessionFeed, type FrameSessionState, type TurnWindow } from '../attribution/sessions.ts';
import { summarizeTurn, type TurnSummary } from '../attribution/turn.ts';
import { WireQueue } from '../attribution/wire.ts';
import type { LedgerAttr } from '../history/ledger-schema.ts';
import { Ledger } from '../history/ledger.ts';
import { RT } from '../present/copy.ts';
import { SERVER_WIDE } from '../present/scope.ts';
import type { ScopeState } from './scope-state.ts';

// Owner: ui-core. The frame's side effects around each poll, coded against the attribution, ledger and alert interfaces
// (docs/2.0/INTERFACES.md §4): marks and verdicts out, labels and Next reply in, ledger rows and badge/toasts from the
// leader only (P9). Nothing here reaches the DOM; presenters read what it exposes.

type Host = Pick<HostClient, 'onSession' | 'onSessionLifecycle' | 'storage' | 'setBadge' | 'toast'>;
export interface PipelineOptions { host: Host; state: ScopeState; now: () => number; surface: string; toasts: () => ToastPreference; auto: () => boolean }

const ledgerAttr = (label: AttributionLabel): LedgerAttr => label.kind === 'inferred' ? 'inferred' : label.kind === 'armed' ? 'armed'
  : label.reason === 'not-observed' || label.reason === 'all-requests' ? 'not-observed' : `withheld:${label.reason}`;
/** A stub that throws must not take monitoring down with it. */
const safe = <T>(run: () => T, fallback: T): T => { try { return run(); } catch { return fallback; } };

export class Pipeline {
  readonly feed: SessionFeed;
  readonly next = new NextReply();
  private readonly wire = new WireQueue();
  private readonly ledger: Ledger;
  private readonly signals: Signals;
  private readonly verdicts = new Map<number, AttributionLabel>();
  private leading = false;
  private ledgerStarted = false;
  constructor(private readonly o: PipelineOptions) {
    this.feed = new SessionFeed(o.host, o.now, () => o.state.snapshot?.service.instance ?? null);
    this.ledger = new Ledger({ storage: o.host.storage, now: o.now });
    this.signals = new Signals(o.host, o.toasts, o.surface);
  }

  /** `mark` and `attr` for the next poll (pre-encoded comma lists, contract §7). */
  query(): { mark?: string; attr?: string } {
    safe(() => this.wire.mark(this.feed.drainMarks()), undefined);
    safe(() => this.wire.attr(this.next.drainAttrs()), undefined);
    return safe(() => this.wire.query(), {});
  }
  private context(snapshot: SnapshotV2, gapMs: number): JoinContext {
    return { connection: { id: snapshot.connection.id, runtime: snapshot.connection.runtime, model: snapshot.runtime.request?.model ?? snapshot.runtime.residency[0]?.model ?? null },
      canCount: !!snapshot.capabilities['server.requests'], covered: (from, to) => this.o.state.covered(from, to, gapMs), auto: this.o.auto() };
  }
  /** After a 200: acknowledge what was sent, join new completions, feed Next reply, the ledger and the signals. */
  received(snapshot: SnapshotV2, fresh: readonly CompletionV2[], visible: boolean): void {
    safe(() => this.wire.acknowledge(), undefined);
    const frame = this.frame(), context = this.context(snapshot, Math.max(2_500, snapshot.nextPollMs * 2.5));
    const verdicts = fresh.filter(item => !item.verdict).map(item => ({ item, verdict: safe(() => join(item, frame, context), null) }));
    for (const { item, verdict } of verdicts) if (verdict) this.verdicts.set(item.seq, verdict.attr === 'inferred' ? { kind: 'inferred' } : { kind: 'server-wide', reason: verdict.reason });
    const attrs = verdicts.flatMap(({ item, verdict }) => verdict ? [{ seq: item.seq, attr: verdict.attr, reason: verdict.attr === 'withheld' ? verdict.reason : null }] : []);
    if (attrs.length) safe(() => this.wire.attr(attrs), undefined);
    if (fresh.length) safe(() => this.next.observe(fresh, frame, this.o.now()), this.next.state);
    this.leading = snapshot.lease.leader && visible;
    safe(() => this.signals.apply(snapshot, []), undefined);
    if (this.leading) void this.record(snapshot);
  }
  private async record(snapshot: SnapshotV2): Promise<void> {
    try {
      if (!this.ledgerStarted) { this.ledgerStarted = true; await this.ledger.start(); }
      this.ledger.append(snapshot.completions, completion => ledgerAttr(this.label(completion)));
      if (this.ledger.due('rows', this.o.now())) await this.ledger.flush('rows');
    } catch { /* Storage trouble never stops monitoring; the ledger backs off on its own. */ }
  }
  /** The frame is going out of view: a leader flushes what it holds (hide flushes ≥ 10 s apart, the ledger decides). */
  hidden(): void {
    if (!this.leading) return;
    this.leading = false;
    void (async () => { try { if (this.ledger.due('hidden', this.o.now())) await this.ledger.flush('hidden'); } catch { /* see record */ } })();
    safe(() => this.next.cancel('hidden'), undefined);
  }
  panelMounted(): void { safe(() => this.signals.panelMounted(), undefined); }

  frame(): FrameSessionState { return safe(() => this.feed.state(), { connected: false, chat: null, windows: [] }); }
  /** A completion's label: the service's recorded verdict, else this frame's own join, else server-wide · not observed. */
  label(completion: CompletionV2): AttributionLabel { return completion.verdict ? labelOf(completion) : this.verdicts.get(completion.seq) ?? SERVER_WIDE; }
  /** The live reading's label: the join rule applied to the request so far. */
  liveLabel(snapshot: SnapshotV2 | null): AttributionLabel {
    const request = snapshot?.runtime.request, window = this.window();
    if (!snapshot || !request) return SERVER_WIDE;
    if (this.next.state.kind === 'measuring') return { kind: 'armed' };
    const now = snapshot.runtime.sampledAt ?? snapshot.serverNow, started = window?.startedAt ?? (request.elapsedMs != null ? now - request.elapsedMs : null);
    const draft: CompletionV2 = { seq: 0, finishedAt: now, startedAt: started, model: request.model, basis: 'observed',
      overlapped: (snapshot.runtime.server.active ?? 0) > 1, host: {} };
    const verdict = safe(() => join(draft, this.frame(), this.context(snapshot, Math.max(2_500, snapshot.nextPollMs * 2.5))), null);
    return verdict?.attr === 'inferred' ? { kind: 'inferred' } : verdict ? { kind: 'server-wide', reason: verdict.reason } : SERVER_WIDE;
  }
  window(): TurnWindow | null { return this.frame().windows.at(-1) ?? null; }
  /** The newest turn's summary, only when every step in it is attributed (decision 11). */
  turn(): TurnSummary | null {
    const window = this.window();
    if (!window) return null;
    const from = window.startedAt ?? -Infinity, to = window.endedAt ?? Infinity;
    const steps = this.o.state.recent.filter(item => item.finishedAt >= from && item.finishedAt <= to + 1_000);
    return steps.length && steps.every(step => this.label(step).kind !== 'server-wide') ? safe(() => summarizeTurn(window, steps), null) : null;
  }
  /** The open chat's runtime name when it isn't the monitored one ("this chat uses Splash"). */
  chatRuntime(): string | null {
    const provider = this.frame().chat?.provider;
    return provider ? RT[provider as keyof typeof RT] ?? null : null;
  }
  get nextState(): NextReplyState { return safe(() => this.next.state, { kind: 'idle' }); }
  arm(snapshot: SnapshotV2 | null): void {
    if (!snapshot) return;
    safe(() => this.next.arm(this.o.now(), this.frame(), this.context(snapshot, Math.max(2_500, snapshot.nextPollMs * 2.5))), this.next.state);
  }
  cancel(): void { safe(() => this.next.cancel('user'), undefined); }
  get firstRun(): boolean { return safe(() => this.ledger.firstRun, false); }
  dispose(): void { safe(() => this.feed.dispose(), undefined); safe(() => this.signals.dispose(), undefined); safe(() => this.ledger.dispose(), undefined); }
}
