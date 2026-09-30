import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { WithholdReason } from '../../src/contract/reasons.ts';
import type { RuntimeKind } from '../../src/contract/runtime.ts';
import { LIFECYCLE_HOLD_MS, type FrameSessionState, type TurnWindow } from './sessions.ts';

// Owner: attribution. The auto rule (plan §5.5 as amended by S2): "This chat · inferred" only when every condition holds
// across the span, else server-wide with exactly one reason. Pure; the frame sends the verdict back as `attr=`.
// S2 removed conditions 1–2 (no `sessions` capability), so another chat alternating requests on the same runtime
// inside this chat's turn cannot be ruled out; the ⓘ says so (why.ts).

/** S2: 1 s hold and tolerance (the plan body's 1.5 s predates the lag measurement). */
export const CLOCK_TOLERANCE_MS = 1_000;
export type JoinVerdict = { attr: 'inferred' } | { attr: 'withheld'; reason: WithholdReason };
/** What presenters show. `all-requests` is panel-only: readings that are server-wide by nature. */
export type AttributionLabel =
  | { kind: 'inferred' } | { kind: 'armed' } | { kind: 'server-wide'; reason: WithholdReason | 'all-requests' | 'not-observed' };
export interface JoinContext {
  connection: {
    id: string; runtime: RuntimeKind | null;
    model: string | null;                    // the runtime's model when unambiguous; a completion's own model wins
    models?: readonly string[];              // every model the runtime lists (request, residency, loaded catalog)
    choices?: readonly string[];             // connection ids Scope can watch instead
  };
  canCount: boolean;                         // capabilities['server.requests'] present
  covered: (from: number, to: number) => boolean;   // ring samples or a healthy event stream cover the span
  auto: boolean;                             // pref attribution.auto
  activeMax?: (from: number, to: number) => number | null;   // most requests any reading in the span saw; null = uncountable
  idleBefore?: (at: number) => number | null;                // start bound for a completion without `startedAt`
}
/** The parts of a completion the rule reads; a live reading passes its turn so far. */
export type Span = Pick<CompletionV2, 'startedAt' | 'finishedAt' | 'model' | 'overlapped'> & Partial<Pick<CompletionV2, 'aggregateOf'>>;
type Identity = { provider: string | null; model: string | null };

const lastSegment = (model: string): string => model.slice(model.lastIndexOf('/') + 1).trim().toLowerCase();
/** S2: a local provider's model is `provider/segment/segment`; match on the last path segment, case-folded. */
export const sameModel = (chat: string | null, runtime: string | null): boolean => {
  if (!chat || !runtime) return false;
  const segment = lastSegment(chat);
  return segment !== '' && segment === lastSegment(runtime);
};
export const labelOf = (completion: Pick<CompletionV2, 'verdict'>): AttributionLabel =>
  completion.verdict?.attr === 'inferred' ? { kind: 'inferred' } : completion.verdict?.attr === 'armed' ? { kind: 'armed' }
    : { kind: 'server-wide', reason: completion.verdict?.reason ?? 'not-observed' };
export const labelOfVerdict = (verdict: JoinVerdict): AttributionLabel =>
  verdict.attr === 'inferred' ? { kind: 'inferred' } : { kind: 'server-wide', reason: verdict.reason };

/** Condition 3: the chat's provider is the monitored connection and its model is the runtime's. */
export const chatMismatch = (chat: Identity | null, runtimeModel: string | null, connection: JoinContext['connection']): WithholdReason | null => {
  if (!chat) return 'not-observed';
  if (!chat.provider || !chat.model) return 'model-unknown';
  if (chat.provider !== connection.id) return 'other-provider';
  if (!runtimeModel) return 'model-unknown';
  return sameModel(chat.model, runtimeModel) ? null : 'model-differs';
};

// A joined window's turn began at an unknown time, but only spans still running when the frame joined can be in it.
const overlaps = (window: TurnWindow, from: number, to: number): boolean =>
  (window.startedAt ?? -Infinity) <= to + CLOCK_TOLERANCE_MS && (window.endedAt ?? Infinity) >= from - CLOCK_TOLERANCE_MS
  && !(window.startedAt === null && window.joinedAt !== undefined && to < window.joinedAt);
/** The span lies inside the window, ±1 s (S2). An open window runs to now. */
export const inside = (window: TurnWindow, from: number, to: number): boolean =>
  from >= (window.startedAt ?? -Infinity) - CLOCK_TOLERANCE_MS && to <= (window.endedAt ?? Infinity) + CLOCK_TOLERANCE_MS;
/** The newest window the span touches. */
export const windowAt = (frame: FrameSessionState, from: number, to: number): TurnWindow | null => {
  for (let index = frame.windows.length - 1; index >= 0; index -= 1) if (overlaps(frame.windows[index]!, from, to)) return frame.windows[index]!;
  return null;
};
const identityOf = (window: TurnWindow | null, frame: FrameSessionState): Identity | null =>
  window && window.provider !== undefined ? { provider: window.provider, model: window.model ?? null } : frame.chat;
const spanStart = (span: Span, context: JoinContext): number | null => span.startedAt ?? context.idleBefore?.(span.finishedAt) ?? null;

/** Condition 4 from the service: the runtime counts requests, and none other ran at any service sample of the span. */
const countReason = (span: Span, context: JoinContext): WithholdReason | null =>
  !context.canCount ? 'cannot-count' : span.overlapped || (span.aggregateOf ?? 1) > 1 ? 'overlap' : null;
/** Condition 4 from this frame's readings, including the 1 s before the span (S2 lag). */
const activeReason = (from: number, to: number, context: JoinContext): WithholdReason | null => {
  const most = context.activeMax?.(from - LIFECYCLE_HOLD_MS, to);
  return most === null ? 'cannot-count' : most !== undefined && most > 1 ? 'overlap' : null;
};
/** Condition 7: one unbroken stretch of readings (or a healthy event stream) from the lag before the span to its end. */
const coverReason = (from: number, to: number, context: JoinContext): WithholdReason | null =>
  context.covered(from - LIFECYCLE_HOLD_MS, to) ? null : 'not-observed';

/** One armed step (Next reply): conditions 3–4 and 7 inside the measured window. Null when every one holds. */
export const stepReason = (span: Span, window: TurnWindow, frame: FrameSessionState, context: JoinContext): WithholdReason | null => {
  const start = spanStart(span, context), end = span.finishedAt;
  return chatMismatch(identityOf(window, frame), span.model ?? context.connection.model, context.connection) ?? countReason(span, context)
    ?? (start === null ? 'not-observed' : activeReason(start, end, context) ?? coverReason(start, end, context));
};

/**
 * The auto rule. Precedence, first failing wins: auto-off · not observed at all · provider/model (3) · counting and
 * service-side overlap (4) · joined mid-turn · this frame's readings (4) · inside a live turn (5) · coverage (7).
 */
export const join = (completion: Span, frame: FrameSessionState, context: JoinContext): JoinVerdict => {
  const reason = joinReason(completion, frame, context);
  return reason ? { attr: 'withheld', reason } : { attr: 'inferred' };
};
const joinReason = (span: Span, frame: FrameSessionState, context: JoinContext): WithholdReason | null => {
  if (!context.auto) return 'auto-off';
  const end = span.finishedAt, start = spanStart(span, context), window = windowAt(frame, start ?? end, end);
  // Without a window, only continuous observation of the chat since before the span says anything about it.
  const observed = frame.connected && frame.observedFrom !== null && frame.observedFrom <= (start ?? end);
  if (!window && !observed) return 'not-observed';
  const early = chatMismatch(identityOf(window, frame), span.model ?? context.connection.model, context.connection) ?? countReason(span, context);
  if (early) return early;
  if (window?.startedAt === null) return 'joined-mid-turn';
  if (start === null) return 'not-observed';
  const active = activeReason(start, end, context);
  if (active) return active;
  if (!window || !inside(window, start, end)) {
    // A window cut by a switch or hide ends observation, not the turn.
    if (window && window.outcome === null && window.endedAt !== null && end > window.endedAt + CLOCK_TOLERANCE_MS) return 'not-observed';
    return observed ? 'outside-turn' : 'not-observed';
  }
  return coverReason(start, end, context);
};

/**
 * The reading in flight: the open chat's turn so far, up to the newest reading at `at`. With no open turn the span is
 * the request's own (from the last idle reading), which is then outside the turn or unobserved.
 */
export const joinLive = (frame: FrameSessionState, context: JoinContext, at: number, model: string | null): JoinVerdict => {
  const open = frame.windows.at(-1), live = open && open.endedAt === null ? open : null;
  const startedAt = live ? live.startedAt ?? at : context.idleBefore?.(at) ?? null;
  return join({ startedAt, finishedAt: at, model, overlapped: false }, frame, context);
};
