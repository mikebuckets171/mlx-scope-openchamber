import type { WithholdReason } from '../../src/contract/reasons.ts';
import type { AttributionLabel } from './join.ts';

// Owner: attribution. The ⓘ for an attribution chip: a title and two sentences (2.0 mock `WHY`, amended for S2). Without
// the `sessions` capability Scope sees only the open chat, so no label may claim that no other chat was running.
// Runtime and provider names only; never a model name, session title or id.

/** Required in every inferred and armed ⓘ (S2 owner decision). */
export const ALTERNATING = 'Another chat alternating requests on the same runtime during this turn can’t be ruled out.';
export type Why = readonly [title: string, first: string, second: string];
export interface WhyParams { provider?: string }

type Reason = WithholdReason | 'all-requests';
const SERVER_WIDE: Record<Reason, (runtime: string, params: WhyParams) => readonly [string, string]> = {
  'other-provider': (rt, p) => [`This chat runs on ${p.provider ?? 'another connection'}, so what ${rt} is doing belongs to another app or chat.`,
    p.provider ? `Watch ${p.provider} to label this chat’s readings.` : 'Readings stay server-wide.'],
  'model-differs': rt => [`This chat’s model isn’t the model ${rt} is running, so the reading belongs to another app or chat.`, 'Scope never loads or switches models.'],
  'model-unknown': rt => [`OpenChamber didn’t say which model this chat uses, or ${rt} didn’t say which model ran, so the reading can’t be tied to this chat.`,
    'Readings stay server-wide until both are known.'],
  'cannot-count': rt => [`${rt} doesn’t report how many requests are running, so no reading can be tied to a chat.`, ''],
  overlap: rt => [`More than one request was running on ${rt}, so no reading belongs to a single chat.`, 'Per-request speed comes back when one request runs.'],
  'outside-turn': rt => [`This request ran on ${rt} while this chat wasn’t in a turn, such as a title or summary request after the reply, or another app.`,
    'Only requests inside this chat’s turn are labelled.'],
  'joined-mid-turn': rt => [`Scope opened while this chat’s turn was already running on ${rt}, so it didn’t see the turn start.`,
    'The next turn can be labelled.'],
  'not-observed': rt => [`No Scope view saw this chat’s turn while the reply ran on ${rt}, so it can’t be tied to a chat.`,
    'Labels need a Scope view open for the whole reply.'],
  'auto-off': () => ['Auto-labelling is off, so readings stay server-wide.', 'Next reply still measures one reply when you arm it.'],
  'all-requests': rt => [`Everything ${rt} is doing, from any app or chat.`, 'Per-chat labels need per-request readings and one running request.'],
  // Not produced since S2 dropped the `sessions` capability; kept so every contract reason has its words.
  'several-chats': rt => [`Another chat was running on ${rt} at the same time, so this reading can’t be tied to this chat.`, 'Readings stay server-wide until one chat is running.'],
  'subagent-running': rt => [`A subagent of this chat was running on ${rt}, so replies can’t be told apart.`, 'Readings stay server-wide until the subagent finishes.'],
  'projects-loading': () => ['OpenChamber was still loading its projects.', 'Readings stay server-wide until it has.'],
  'projects-error': () => ['OpenChamber’s project list was unavailable.', 'Readings stay server-wide.'],
  'too-many-projects': () => ['There are too many projects to follow.', 'Readings stay server-wide.'],
};

export const attributionWhy = (label: AttributionLabel, runtime: string, live: boolean, params: WhyParams = {}): Why => {
  if (label.kind === 'inferred') return ['This chat · inferred', live
    ? `So far this chat has been in a turn on ${runtime} the whole time, with one request at a time and a matching model, and Scope has seen every reading since the reply started.`
    : `This chat was in a turn on ${runtime} the whole time, with one request at a time and a matching model, and Scope saw the whole reply.`,
  `Inferred from OpenChamber’s chat activity: ${runtime} doesn’t report which chat a request came from. ${ALTERNATING} OpenChamber’s own background model calls, such as title generation, can fall inside an inferred turn.`];
  if (label.kind === 'armed') return ['Next reply · armed', live
    ? `You armed Next reply, and so far every step has run on ${runtime} one request at a time with a matching model.`
    : `You armed Next reply, and every step ran on ${runtime} one request at a time with a matching model.`,
  `Still inferred from chat activity, not reported by ${runtime}. ${ALTERNATING}`];
  const [first, second] = SERVER_WIDE[label.reason](runtime, params);
  return ['Server-wide', first, second];
};
