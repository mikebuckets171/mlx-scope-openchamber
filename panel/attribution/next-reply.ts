import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { WithholdReason } from '../../src/contract/reasons.ts';
import { CLOCK_TOLERANCE_MS, inside, sameModel, stepReason, type JoinContext } from './join.ts';
import { LIFECYCLE_HOLD_MS, type FrameSessionState, type TurnWindow } from './sessions.ts';
import { summarizeTurn, type TurnSummary } from './turn.ts';

// Owner: attribution. Armed "Next reply" capture, a port of PR #8 (reply-capture.ts). Conditions 3–4 per step (S2
// removed 2); cancels on chat switch, runtime unavailable, or the arming frame becoming invisible or unmounting.
// No timers: the frame's own polls drive it, as in PR #8.

export const REPLY_WAIT_MS = 120_000;
export const REPLY_LIMIT_MS = 600_000;
/** `timeout`: no reply started within REPLY_WAIT_MS · `limit`: REPLY_LIMIT_MS reached · `clock`: the clock ran backwards. */
export type NextReplyCancel = 'switched' | 'unavailable' | 'hidden' | 'timeout' | 'limit' | 'clock' | 'user';
export type NextReplyState =
  | { kind: 'idle' }
  | { kind: 'offer-watch'; runtime: string }  // the chat runs on another watchable connection: "Watch …" instead of arming
  | { kind: 'refused'; reason: WithholdReason }   // won't arm: the chat's model differs or is unknown, or requests can't be counted
  | { kind: 'armed'; at: number }
  | { kind: 'measuring'; startedAt: number; steps: CompletionV2[] }
  | { kind: 'result'; startedAt: number; endedAt: number; steps: CompletionV2[]; attributed: boolean; summary: TurnSummary | null }
  | { kind: 'cancelled'; reason: NextReplyCancel };
/** Per-poll inputs besides the completions: a fresh context, and when the newest runtime reading was taken. */
export interface NextReplyObservation { context?: JoinContext; sampledAt?: number }

type Chat = NonNullable<FrameSessionState['chat']>;
/** Why the open chat cannot be measured on this connection; null when it can. */
export const armRefusal = (chat: Chat, context: JoinContext): WithholdReason | null => {
  if (!chat.provider || !chat.model) return 'model-unknown';
  if (chat.provider !== context.connection.id) return 'other-provider';
  // A runtime that lists no model can still be measured: each step's own model decides.
  const models = context.connection.models ?? (context.connection.model ? [context.connection.model] : []);
  if (models.length && !models.some(model => sameModel(chat.model, model))) return 'model-differs';
  return context.canCount ? null : 'cannot-count';
};

export class NextReply {
  private current: NextReplyState = { kind: 'idle' };
  private tag: string | null = null;
  private context: JoinContext | null = null;
  private clock = -Infinity;
  private seen = new Set<number>();
  private pending: Array<{ seq: number; attr: 'armed'; reason: null }> = [];

  get state(): NextReplyState { return this.current; }
  get active(): boolean { return this.current.kind === 'armed' || this.current.kind === 'measuring'; }

  /** Arms on the open chat, or says why not. Arming during a running turn waits for the next one. */
  arm(now: number, frame: FrameSessionState, context: JoinContext): NextReplyState {
    if (this.active) return this.current;
    const chat = frame.chat, refusal = !frame.connected || !chat ? 'not-observed' : armRefusal(chat, context);
    if (refusal === 'other-provider' && chat?.provider && context.connection.choices?.includes(chat.provider)) {
      return this.current = { kind: 'offer-watch', runtime: chat.provider };
    }
    if (refusal) return this.current = { kind: 'refused', reason: refusal };
    this.tag = chat!.tag; this.context = context; this.clock = now; this.seen = new Set();
    return this.current = { kind: 'armed', at: now };
  }

  observe(completions: readonly CompletionV2[], frame: FrameSessionState, now: number, extra: NextReplyObservation = {}): NextReplyState {
    if (!this.active) return this.current;
    if (extra.context) this.context = extra.context;
    if (now < this.clock - CLOCK_TOLERANCE_MS) return this.stop('clock');
    this.clock = Math.max(this.clock, now);
    if (frame.chat?.tag !== this.tag) return this.stop('switched');
    let state = this.current as Extract<NextReplyState, { kind: 'armed' | 'measuring' }>;
    if (state.kind === 'armed') {
      if (now >= state.at + REPLY_WAIT_MS) return this.stop('timeout');
      const at = state.at, started = frame.windows.find(window => window.tag === this.tag && window.startedAt !== null && window.startedAt >= at);
      if (!started) return this.current;
      state = this.current = { kind: 'measuring', startedAt: started.startedAt!, steps: [] };
    }
    if (now >= state.startedAt + REPLY_LIMIT_MS) return this.stop('limit');
    const startedAt = state.startedAt, window = frame.windows.find(item => item.tag === this.tag && item.startedAt === startedAt);
    // A window cut by a switch or hide: observation stopped mid-reply.
    if (!window || window.endedAt !== null && window.outcome === null) return this.stop('switched');
    const steps = [...state.steps, ...this.steps(completions, window, frame, now)]
      .sort((a, b) => a.finishedAt - b.finishedAt || a.seq - b.seq);
    // The last step arrives with the first reading after the runtime went idle; wait for one taken after the end.
    const settled = window.endedAt !== null && now >= window.endedAt + LIFECYCLE_HOLD_MS && (extra.sampledAt ?? now) >= window.endedAt + CLOCK_TOLERANCE_MS;
    if (!settled) return this.current = { kind: 'measuring', startedAt, steps };
    const attributed = steps.length > 0 && steps.every(step => step.verdict?.attr === 'armed');
    this.tag = null; this.context = null;
    return this.current = { kind: 'result', startedAt, endedAt: window.endedAt!, steps, attributed, summary: attributed ? summarizeTurn(window, steps) : null };
  }

  /** `user` also dismisses a result, refusal or offer. Other reasons stop only an armed or measuring capture. */
  cancel(reason: NextReplyCancel): void {
    if (this.active) this.stop(reason);
    else if (reason === 'user') this.current = { kind: 'idle' };
  }

  /** `attr=` entries for steps this capture verified (`armed`), newest last. */
  drainAttrs(): Array<{ seq: number; attr: 'armed'; reason: null }> { return this.pending.splice(0); }

  /** Each new completion inside the measured window is one step, checked on its own; a failing step stays server-wide. */
  private steps(completions: readonly CompletionV2[], window: TurnWindow, frame: FrameSessionState, now: number): CompletionV2[] {
    const steps: CompletionV2[] = [];
    for (const completion of completions) {
      const end = completion.finishedAt, start = completion.startedAt ?? this.context?.idleBefore?.(end) ?? end;
      if (this.seen.has(completion.seq) || !inside(window, start, end)) continue;
      this.seen.add(completion.seq);
      const reason = stepReason(completion, window, frame, this.context!);
      if (!reason) this.pending.push({ seq: completion.seq, attr: 'armed', reason: null });
      steps.push(reason ? { ...completion, overlapped: completion.overlapped || reason === 'overlap', verdict: { attr: 'withheld', reason, at: now } }
        : { ...completion, verdict: { attr: 'armed', at: now } });
    }
    return steps;
  }

  private stop(reason: NextReplyCancel): NextReplyState {
    this.tag = null; this.context = null;
    return this.current = { kind: 'cancelled', reason };
  }
}
