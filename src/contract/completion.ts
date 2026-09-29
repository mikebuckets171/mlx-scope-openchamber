import { basis, type Basis } from './capabilities.ts';
import { at, bool, count, defined, fraction, hex8, list, modelLabel, nonneg, obj, oneOf, opt, signedInt } from './guards.ts';
import { thermalLevel, type PressureLevel, type ThermalLevel } from './host.ts';
import { withholdReason, type WithholdReason } from './reasons.ts';

export const MAX_COMPLETIONS = 64;
export const VERDICTS = ['inferred', 'withheld', 'armed'] as const;
export type Verdict = typeof VERDICTS[number];

export interface CompletionV2 {
  seq: number;                               // monotonic per service instance
  finishedAt: number;
  startedAt: number | null;
  model: string | null;
  basis: Basis;                              // per the contract §4 runtime table
  promptTokens?: number; cachedTokens?: number; outputTokens?: number;
  ttftMs?: number; prefillMs?: number; decodeTps?: number; prefillTps?: number;
  overlapped: boolean;                       // another request was active at any sample in its span
  aggregateOf?: number;                      // > 1 when one counter step covered several requests
  verdict?: { attr: Verdict; reason?: WithholdReason; at: number };
  host: {
    pressureMax?: PressureLevel;
    swapDeltaBytes?: number;                 // signed
    gpuAllocMaxBytes?: number;               // driver-reported; a co-factor only, never an alert
    thermalMaxLevel?: ThermalLevel;
    energyJ?: number;                        // macmon estimate, only with powerCoverage ≥ 0.8
    powerCoverage?: number;
  };
}
export interface CompletionsV2 {
  instance: string;                          // = service.instance; a change means the ring restarted
  cursor: number;                            // newest seq in the ring
  reset: boolean;                            // `since` was from another instance or fell off the ring
  items: CompletionV2[];                     // seq > since, oldest first, ≤ 64 per response
}

const verdict = (value: unknown): CompletionV2['verdict'] | undefined => {
  const item = obj(value), attr = oneOf(VERDICTS)(item?.attr), when = at(item?.at), reason = withholdReason(item?.reason);
  // A server-wide label always names its reason; a withheld verdict without one is not a verdict.
  if (!attr || when === null || attr === 'withheld' && !reason) return undefined;
  return defined({ attr, reason: opt(reason), at: when });
};
const completionHost = (value: unknown): CompletionV2['host'] => {
  const item = obj(value) ?? {}, coverage = fraction(item.powerCoverage);
  return defined({
    pressureMax: opt(oneOf([1, 2, 4] as const)(item.pressureMax)), swapDeltaBytes: opt(signedInt(item.swapDeltaBytes)),
    gpuAllocMaxBytes: opt(count(item.gpuAllocMaxBytes)), thermalMaxLevel: opt(thermalLevel(item.thermalMaxLevel)),
    energyJ: coverage !== null && coverage >= 0.8 ? opt(nonneg(item.energyJ)) : undefined, powerCoverage: opt(coverage),
  });
};

export const parseCompletionV2 = (value: unknown): CompletionV2 | null => {
  const item = obj(value), seq = count(item?.seq), finishedAt = at(item?.finishedAt), kind = basis(item?.basis), overlapped = bool(item?.overlapped);
  if (!item || !seq || finishedAt === null || !kind || overlapped === null) return null;
  const startedAt = at(item.startedAt), aggregate = count(item.aggregateOf);
  return defined({
    seq, finishedAt, startedAt: startedAt !== null && startedAt <= finishedAt ? startedAt : null, model: modelLabel(item.model), basis: kind,
    promptTokens: opt(count(item.promptTokens)), cachedTokens: opt(count(item.cachedTokens)),
    outputTokens: opt(count(item.outputTokens)), ttftMs: opt(nonneg(item.ttftMs)), prefillMs: opt(nonneg(item.prefillMs)),
    decodeTps: opt(nonneg(item.decodeTps)), prefillTps: opt(nonneg(item.prefillTps)), overlapped,
    aggregateOf: aggregate !== null && aggregate > 1 ? aggregate : undefined, verdict: verdict(item.verdict), host: completionHost(item.host),
  });
};

/** Items must belong to `instance`, rise strictly, and not pass the cursor; the newest 64 are kept. */
export const parseCompletionsV2 = (value: unknown, instance: string): CompletionsV2 | null => {
  const item = obj(value), cursor = count(item?.cursor), reset = bool(item?.reset);
  if (!item || hex8(item.instance) !== instance || cursor === null || reset === null) return null;
  let last = 0;
  const items = list(item.items, Infinity, parseCompletionV2).filter(entry => {
    if (entry.seq <= last || entry.seq > cursor) return false;
    last = entry.seq;
    return true;
  }).slice(-MAX_COMPLETIONS);
  return { instance, cursor, reset, items };
};
