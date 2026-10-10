import { at, count, defined, nonneg, obj, oneOf, opt } from './guards.ts';

export const CHAT_PHASES = ['waiting', 'generating', 'reasoning', 'tool', 'complete', 'cancelled'] as const;
export type ChatPhase = typeof CHAT_PHASES[number];
export const CHAT_BASES = ['estimated-characters', 'calibrated-characters', 'reported-output'] as const;
/**
 * The one delivery scope this contract accepts, local or cloud: what OpenCode actually delivered to the session.
 * It includes network and provider buffering and is never the engine's native decode throughput. Engine readings
 * are a separate measurement and never borrow these values, and a cloud delivery never borrows a local engine one.
 * Matching identities (session/provider/model/endpoint) stay in the service and never reach the wire.
 */
export const CHAT_SCOPE = 'chat' as const;
export interface ChatMeasurement {
  /** Delivery observed through OpenCode — network and provider buffering included; never engine throughput. */
  scope: typeof CHAT_SCOPE;
  basis: typeof CHAT_BASES[number];
  timingBasis: 'delivery-window' | 'completed-step';
  phase: ChatPhase;
  tokensPerSecond?: number;
  observedAtMs: number;
  expiresAtMs: number;
  observation: { startedAtMs: number; endedAtMs: number };
  freshness: 'live' | 'last';
  calibrationSteps?: number;
}

/** Rebuild the optional extension from an allowlist; reject contradictory or stale observations. */
export const parseChatMeasurement = (value: unknown, now?: number): ChatMeasurement | null => {
  const item = obj(value), observation = obj(item?.observation);
  const basis = oneOf(CHAT_BASES)(item?.basis), phase = oneOf(CHAT_PHASES)(item?.phase);
  const timingBasis = oneOf(['delivery-window', 'completed-step'] as const)(item?.timingBasis);
  const freshness = oneOf(['live', 'last'] as const)(item?.freshness);
  const observedAtMs = at(item?.observedAtMs), expiresAtMs = at(item?.expiresAtMs);
  const startedAtMs = at(observation?.startedAtMs), endedAtMs = at(observation?.endedAtMs);
  const rate = nonneg(item?.tokensPerSecond), calibrationSteps = count(item?.calibrationSteps);
  if (item?.scope !== CHAT_SCOPE || !basis || !phase || !timingBasis || !freshness
    || observedAtMs === null || expiresAtMs === null || startedAtMs === null || endedAtMs === null
    || startedAtMs > endedAtMs || endedAtMs > observedAtMs || expiresAtMs <= observedAtMs
    || expiresAtMs - observedAtMs > 15_000
    || now !== undefined && (observedAtMs > now || expiresAtMs <= now)
    || item.tokensPerSecond !== undefined && rate === null
    || item.calibrationSteps !== undefined && calibrationSteps === null
    || calibrationSteps !== null && calibrationSteps > 10) return null;
  const complete = phase === 'complete';
  if ((freshness === 'last') !== complete || (timingBasis === 'completed-step') !== complete
    || (basis === 'reported-output') !== complete
    || basis === 'calibrated-characters' && (calibrationSteps === null || calibrationSteps < 3)
    || basis !== 'calibrated-characters' && calibrationSteps !== null
    || !complete && endedAtMs - startedAtMs > 5_000
    || rate !== null && !['generating', 'reasoning', 'complete'].includes(phase)
    || rate !== null && (!complete && endedAtMs - startedAtMs < 2_000 || endedAtMs === startedAtMs)
    || !complete && expiresAtMs - observedAtMs > 5_000) return null;
  return defined({ scope: CHAT_SCOPE, basis, phase, timingBasis, freshness,
    observedAtMs, expiresAtMs, observation: { startedAtMs, endedAtMs },
    tokensPerSecond: opt(rate), calibrationSteps: opt(calibrationSteps) });
};
