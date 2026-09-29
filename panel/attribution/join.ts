import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { WithholdReason } from '../../src/contract/reasons.ts';
import type { RuntimeKind } from '../../src/contract/runtime.ts';
import type { FrameSessionState } from './sessions.ts';

// Owner: attribution. The auto rule (plan §5.5 as amended by S2): "This chat · inferred" only when every condition holds
// across the span, else server-wide with exactly one reason. Pure; the frame sends the verdict back as `attr=`.

export const CLOCK_TOLERANCE_MS = 1_500;
export type JoinVerdict = { attr: 'inferred' } | { attr: 'withheld'; reason: WithholdReason };
/** What presenters show. `all-requests` is panel-only: readings that are server-wide by nature. */
export type AttributionLabel =
  | { kind: 'inferred' } | { kind: 'armed' } | { kind: 'server-wide'; reason: WithholdReason | 'all-requests' | 'not-observed' };
export interface JoinContext {
  connection: { id: string; runtime: RuntimeKind | null; model: string | null };
  canCount: boolean;                         // capabilities['server.requests'] present
  covered: (from: number, to: number) => boolean;   // ring samples or a healthy event stream cover the span
  auto: boolean;                             // pref attribution.auto
}
export const join = (completion: CompletionV2, frame: FrameSessionState, context: JoinContext): JoinVerdict => {
  void completion; void frame; void context;
  return { attr: 'withheld', reason: 'not-observed' };
};
/** Provider/model match after normalising both sides (case, quantisation suffixes, publisher prefix). */
export const sameModel = (chat: string | null, runtime: string | null): boolean => { void chat; void runtime; return false; };
export const labelOf = (completion: Pick<CompletionV2, 'verdict'>): AttributionLabel =>
  completion.verdict?.attr === 'inferred' ? { kind: 'inferred' } : completion.verdict?.attr === 'armed' ? { kind: 'armed' }
    : { kind: 'server-wide', reason: completion.verdict?.reason ?? 'not-observed' };
