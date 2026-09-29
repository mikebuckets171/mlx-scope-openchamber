import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { FrameSessionState } from './sessions.ts';
import type { JoinContext } from './join.ts';

// Owner: attribution. Armed "Next reply" capture, a port of PR #8 (reply-capture.ts). Conditions 2–4 per step; cancels
// on chat switch, runtime unavailable, or the arming frame becoming invisible or unmounting.

export const REPLY_WAIT_MS = 120_000;
export const REPLY_LIMIT_MS = 600_000;
export type NextReplyCancel = 'switched' | 'unavailable' | 'hidden' | 'timeout' | 'user';
export type NextReplyState =
  | { kind: 'idle' }
  | { kind: 'offer-watch'; runtime: string }  // the chat's provider/model differs: "Watch …" instead of arming
  | { kind: 'armed'; at: number }
  | { kind: 'measuring'; startedAt: number; steps: CompletionV2[] }
  | { kind: 'result'; startedAt: number; endedAt: number; steps: CompletionV2[]; attributed: boolean }
  | { kind: 'cancelled'; reason: NextReplyCancel };
export class NextReply {
  get state(): NextReplyState { return { kind: 'idle' }; }
  arm(now: number, frame: FrameSessionState, context: JoinContext): NextReplyState { void now; void frame; void context; return this.state; }
  observe(completions: readonly CompletionV2[], frame: FrameSessionState, now: number): NextReplyState { void completions; void frame; void now; return this.state; }
  cancel(reason: NextReplyCancel): void { void reason; }
  /** `attr=` entries for steps this capture verified (`armed`), newest last. */
  drainAttrs(): Array<{ seq: number; attr: 'armed'; reason: null }> { return []; }
}
