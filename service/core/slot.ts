/**
 * One connection slot's health, as a pure state machine: detecting → ready ⇄ degraded → failing(n) → redetect.
 * Times are the caller's clock. The scheduler owns the only backoff and derives it from `failures`.
 */
export type FailureReason = 'runtime_unreachable' | 'authentication_failed' | 'unsupported_runtime';
export type SlotState =
  | { kind: 'detecting'; since: number }
  | { kind: 'ready'; since: number }
  // An unsupported reading still shows what can be read, so it is degraded, not failing; `unsupported` counts them in a row.
  | { kind: 'degraded'; since: number; unsupported: number }
  | { kind: 'failing'; since: number; failures: number; reason: FailureReason; streak: number };
export type SlotEvent = { kind: 'ready' } | { kind: 'degraded'; unsupported?: boolean } | { kind: 'failed'; reason: FailureReason } | { kind: 'redetect' };

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 8_000;
/** Consecutive unsupported readings before re-detection; and how long unreachable counts as "the runtime went away". */
export const REDETECT_STREAK = 3;
export const REDETECT_AFTER_MS = 30_000;

export const initialSlot = (at: number): SlotState => ({ kind: 'detecting', since: at });

export const stepSlot = (state: SlotState, event: SlotEvent, at: number): SlotState => {
  if (event.kind === 'redetect') return { kind: 'detecting', since: at };
  if (event.kind === 'ready') return state.kind === 'ready' ? state : { kind: 'ready', since: at };
  if (event.kind === 'degraded') {
    const was = state.kind === 'degraded' ? state : null;
    return { kind: 'degraded', since: was?.since ?? at, unsupported: event.unsupported ? (was?.unsupported ?? 0) + 1 : 0 };
  }
  if (state.kind !== 'failing') return { kind: 'failing', since: at, failures: 1, reason: event.reason, streak: 1 };
  // `since` marks the start of the episode; `streak` counts the current reason only.
  return { ...state, failures: state.failures + 1, reason: event.reason, streak: state.reason === event.reason ? state.streak + 1 : 1 };
};

/** min(8 s, 0.5 s · 2ⁿ) after n consecutive failures; nothing while healthy. */
export const backoffMs = (failures: number): number =>
  failures > 0 ? Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures, 5)) : 0;
export const failuresOf = (state: SlotState): number => state.kind === 'failing' ? state.failures : 0;

/**
 * Whether the move from `previous` to `next` calls for a fresh detection pass: the third unsupported reading in a row,
 * or the first answer after the runtime was unreachable for 30 s (a port swap). The third, not every later one: a pass
 * resets the slot to detecting, so a runtime that stays unsupported is re-checked every three readings, never on each.
 */
export const redetectDue = (previous: SlotState, next: SlotState, at: number): boolean =>
  next.kind === 'degraded' ? next.unsupported === REDETECT_STREAK || recovered(previous, at)
    : next.kind === 'ready' && recovered(previous, at);
const recovered = (previous: SlotState, at: number): boolean =>
  previous.kind === 'failing' && previous.reason === 'runtime_unreachable' && at - previous.since >= REDETECT_AFTER_MS;
