import type { WithholdReason } from '../../src/contract/reasons.ts';
import type { AttributionLabel } from './join.ts';

// Owner: attribution. The ⓘ for an attribution chip: a title and two sentences (2.0 mock `WHY`, amended for S2). Without
// the `sessions` capability Scope sees only the open chat, so no label may claim that no other chat was running.
// Runtime and provider names only; never a model name, session title or id.

/** Required in every inferred and armed ⓘ (S2 owner decision). */
export const ALTERNATING = 'Another chat may have used the same server between readings.';
export type Why = readonly [title: string, first: string, second: string];
export interface WhyParams { provider?: string }

type Reason = WithholdReason | 'all-requests';
const SERVER_WIDE: Record<Reason, (runtime: string, params: WhyParams) => readonly [string, string]> = {
  'other-provider': (rt, p) => [`This chat runs on ${p.provider ?? 'another connection'}, so what ${rt} is doing belongs to another app or chat.`,
    p.provider ? `Watch ${p.provider} to label this chat’s readings.` : 'Readings include all server activity.'],
  'model-differs': rt => [`This chat’s model isn’t the model ${rt} is running, so the reading belongs to another app or chat.`, 'Scope never loads or switches models.'],
  'model-unknown': rt => [`OpenChamber didn’t say which model this chat uses, or ${rt} didn’t say which model ran, so the reading can’t be tied to this chat.`,
    'Readings include all server activity until both models are known.'],
  'cannot-count': rt => [`${rt} doesn’t report how many requests are running, so no reading can be tied to a chat.`, ''],
  overlap: rt => [`More than one request was running on ${rt}, so no reading belongs to a single chat.`, 'Per-request speed comes back when one request runs.'],
  'outside-turn': rt => [`This request ran on ${rt} while this chat wasn’t in a turn, such as a title or summary request after the reply, or another app.`,
    'Only requests inside this chat’s turn are labelled.'],
  'joined-mid-turn': rt => [`Scope opened while this chat’s turn was already running on ${rt}, so it didn’t see the turn start.`,
    'The next turn can be labelled.'],
  'not-observed': rt => [`No Scope view saw this chat’s turn while the reply ran on ${rt}, so it can’t be tied to a chat.`,
    'Labels need a Scope view open for the whole reply.'],
  'auto-off': () => ['Automatic chat labels are off, so readings include all server activity.', 'Measure next reply still records one reply when you start it.'],
  'all-requests': rt => [`Everything ${rt} is doing, from any app or chat.`, 'Per-chat labels need per-request readings and one running request.'],
};

export const attributionWhy = (label: AttributionLabel, runtime: string, live: boolean, params: WhyParams = {}): Why => {
  if (label.kind === 'inferred') return ['Likely this chat', live
    ? `So far this chat has been in a turn on ${runtime} the whole time, with one request at a time and a matching model, and Scope has seen every reading since the reply started.`
    : `This chat was in a turn on ${runtime} the whole time, with one request at a time and a matching model, and Scope saw the whole reply.`,
  `Based on OpenChamber’s chat activity: ${runtime} doesn’t report which chat a request came from. ${ALTERNATING} OpenChamber’s own background model calls, such as title generation, may be included in this turn.`];
  if (label.kind === 'armed') return ['Next reply', live
    ? `You started Measure next reply, and so far every step has run on ${runtime} one request at a time with a matching model.`
    : `You started Measure next reply, and every step ran on ${runtime} one request at a time with a matching model.`,
  `This match is based on chat activity; it is not confirmed by ${runtime}. ${ALTERNATING}`];
  const [first, second] = SERVER_WIDE[label.reason](runtime, params);
  return ['All server activity', first, second];
};
