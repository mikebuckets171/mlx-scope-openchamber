import { BASES, type Basis } from '../../src/contract/capabilities.ts';
import type { CompletionV2 } from '../../src/contract/completion.ts';
import { runtimeKind, runtimeNames, type RuntimeKind } from '../../src/contract/runtime.ts';
import { REPLY_WAIT_MS, type NextReplyCancel, type NextReplyState } from '../attribution/next-reply.ts';
import { summarizeTurn } from '../attribution/turn.ts';
import { CAPTURE_LIMIT, type CaptureV2 } from '../captures/store.ts';
import { windowRate, type WindowCaptureState, type WindowLengthMs } from '../captures/window.ts';
import { clamp, redact, SCOPE_TEXT_MAX_CHARS } from '../share/report.ts';
import { gibText, mmss } from './format.ts';
import { basisNote, weightedTps } from './parts.ts';
import { ago, delta, dur, HISTORY_TEXT, int, pct, tps, type AttrChip, type HistoryText } from './history.ts';

// Owner: ui-history. The Captures tab (plan §5.9, G2): Next reply, the 30/60 s window and ≤ 12 saved captures, plus the
// 1.x captures read-only. Class B: a capture stores and shares runtime kinds and numbers, never a model name.

/** What the shell hands the tab for the armed Next reply (attribution's NextReply, wired to the frame's sessions). */
export interface NextReplyControl { state(): NextReplyState; arm(): void; cancel(): void; watch?(): void }
export interface ValueView { text: string; basis: Basis; note: string | null }
export type NextAction = 'arm' | 'cancel' | 'watch' | 'save-next';
export interface NextCard {
  state: NextReplyState['kind'] | 'unavailable';
  chip: AttrChip | null;
  note: string;
  time: { value: string; suffix: string } | null;
  result: { chip: AttrChip; ago: string; values: ValueView[]; split: ValueView[] } | null;
  actions: Array<{ action: NextAction; label: string; primary?: boolean }>;
}
export interface WindowCard {
  status: 'idle' | 'recording' | 'finished' | 'interrupted';
  lengthMs: WindowLengthMs; state: string; progress: number | null; values: ValueView[]; canSave: boolean;
}
export interface SavedRow {
  key: string; at: string; iso: string; rate: ValueView | null; title: string; chip: AttrChip; comparing: boolean; delta: ValueView | null;
}
export interface CapturesInput {
  now: number;
  runtime: RuntimeKind | null;
  runtimeName: string;
  completions: boolean;                      // capabilities['server.completions']: the runtime reports replies
  paused: boolean;
  next: NextReplyState | null;               // null: the shell gave this frame no Next reply control
  nextSaved: boolean;
  window: WindowCaptureState | null;
  windowLength: WindowLengthMs;
  saved: readonly CaptureV2[];
  legacy: readonly CaptureV2[];
  reference: string | null;
  text?: HistoryText;
}
export interface CapturesView {
  next: NextCard; window: WindowCard;
  saved: { right: string; rows: SavedRow[]; empty: string | null; share: boolean };
  legacy: { right: string; rows: SavedRow[] } | null;
}

const value = (text: string, basis: Basis, note?: string): ValueView => ({ text, basis, note: note ?? basisNote(basis) });
const CANCELLED: Readonly<Record<NextReplyCancel, string>> = {
  switched: 'Cancelled: you switched chats.', unavailable: 'Cancelled: the server stopped answering.', hidden: 'Cancelled: this view closed.',
  timeout: 'Stopped: no reply finished in time.', limit: 'Stopped: the reply ran past 10 minutes.',
  clock: 'Cancelled: the clock changed, so the timing can’t be trusted.', user: 'Cancelled.',
};
const ARMED: AttrChip = { attr: 'armed', text: 'Next reply', reason: null };
const labelChip = (label: CaptureV2['label'], text: HistoryText): AttrChip => label === 'armed' ? ARMED : { attr: 'server', text: text.withheld('all-requests'), reason: 'all-requests' };
const nameOf = (runtime: string | null): string => { const kind = runtimeKind(runtime); return kind ? runtimeNames[kind] : 'server not recorded'; };

// ---------- measurements: allowlisted numbers, never a model name (capture.v2 is a share sink) ----------
/** The keys this tab writes into `CaptureV2.measurements`; units in the name. `decodeBasis` indexes BASES. */
export const CAPTURE_MEASUREMENTS = ['decodeTps', 'decodeBasis', 'outputTokens', 'promptTokens', 'cachedTokens', 'ttftMs', 'wholeMs', 'modelMs', 'toolMs', 'steps',
  'windowMs', 'observedMs', 'samples', 'decodeMs', 'completions', 'cpuMeanFraction', 'cpuPeakFraction', 'memMeanBytes', 'memPeakBytes', 'footprintPeakBytes', 'swapDeltaBytes'] as const;
export type CaptureMeasurement = typeof CAPTURE_MEASUREMENTS[number];
const numbers = (entries: Array<[CaptureMeasurement, number | null | undefined]>): Record<string, number> =>
  Object.fromEntries(entries.filter((entry): entry is [CaptureMeasurement, number] => entry[1] != null && Number.isFinite(entry[1])));
/** Token-weighted Σtok / Σ(tok/tps): a multi-step rate is Scope's arithmetic, so it is `derived`. */
const weighted = (steps: readonly CompletionV2[]): { tps: number; basis: Basis } | null => {
  const tps = weightedTps(steps);
  return tps === null ? null : { tps, basis: steps.length === 1 ? steps[0]!.basis : 'derived' };
};
const sum = (steps: readonly CompletionV2[], pick: (step: CompletionV2) => number | undefined): number | null =>
  steps.every(step => pick(step) !== undefined) && steps.length ? steps.reduce((total, step) => total + pick(step)!, 0) : null;
type Result = Extract<NextReplyState, { kind: 'result' }>;
export const nextReplyCapture = (result: Result, runtime: RuntimeKind | null, savedAt: number): CaptureV2 => {
  const rate = weighted(result.steps), first = result.steps[0];
  const turn = summarizeTurn({ tag: '', startedAt: result.startedAt, endedAt: result.endedAt, outcome: 'completed' }, result.steps);
  return { v: 2, savedAt, kind: 'next-reply', runtime, label: result.attributed ? 'armed' : 'server-wide', state: 'finished',
    measurements: numbers([['decodeTps', rate?.tps], ['decodeBasis', rate ? BASES.indexOf(rate.basis) : null], ['outputTokens', sum(result.steps, step => step.outputTokens)],
      ['promptTokens', sum(result.steps, step => step.promptTokens)], ['cachedTokens', sum(result.steps, step => step.cachedTokens)],
      ['ttftMs', first && first.basis !== 'last-observed' ? first.ttftMs : null], ['wholeMs', result.endedAt - result.startedAt],
      ['modelMs', turn?.modelMs], ['toolMs', turn?.toolMs], ['steps', result.steps.length]]) };
};
export const windowCapture = (state: WindowCaptureState, savedAt: number): CaptureV2 => {
  const rate = windowRate(state);
  return { v: 2, savedAt, kind: 'window', runtime: state.runtime, label: 'server-wide', state: state.status === 'finished' ? 'finished' : 'interrupted',
    measurements: numbers([['decodeTps', rate], ['decodeBasis', rate === null ? null : BASES.indexOf('observed')], ['outputTokens', state.decodeTokens],
      ['decodeMs', state.decodeMs], ['windowMs', state.targetMs], ['observedMs', state.endedAt - state.startedAt], ['samples', state.samples],
      ['completions', state.completions], ['cpuMeanFraction', state.cpuMean], ['cpuPeakFraction', state.cpuPeak], ['memMeanBytes', state.memMeanBytes && Math.round(state.memMeanBytes)],
      ['memPeakBytes', state.memPeakBytes], ['footprintPeakBytes', state.footprintPeakBytes],
      ['swapDeltaBytes', state.swapStartBytes !== null && state.swapEndBytes !== null ? state.swapEndBytes - state.swapStartBytes : null]]) };
};

/** The headline rate. Migrated 1.x windows carry `observedDecodeTps`; older records may keep their 1.6 names. */
export const captureRate = (capture: CaptureV2): { tps: number; basis: Basis } | null => {
  const m = capture.measurements, tps = m.decodeTps ?? m.observedDecodeTps ?? m.observedGeneration ?? m.generation;
  if (tps === undefined || !Number.isFinite(tps) || tps <= 0) return null;
  const stored = m.decodeBasis === undefined ? undefined : BASES[m.decodeBasis];
  // Without a stored basis: a 1.6 snapshot showed the runtime's reported rate; windows count output Scope observed.
  return { tps, basis: stored ?? (capture.kind === 'snapshot' || m.generation !== undefined && m.decodeTps === undefined ? 'reported' : 'observed') };
};
export const captureKey = (capture: CaptureV2, legacy = false): string => `${legacy ? 'v1' : 'v2'}:${capture.savedAt}`;
const title = (capture: CaptureV2): string => {
  const kind = capture.kind === 'next-reply' ? 'Next reply' : capture.kind === 'window' ? `Window ${Math.round((capture.measurements.windowMs ?? 60_000) / 1000)} s`
    : capture.kind === 'snapshot' ? 'Snapshot' : 'Window with reference';
  return `${kind} · ${nameOf(capture.runtime)}${capture.state === 'interrupted' ? ' · partial' : ''}`;
};

// ---------- the view ----------
const presentNext = (input: CapturesInput): NextCard => {
  const note = 'Measures your next reply in this chat, then stops.', state = input.next, rt = input.runtimeName;
  const arm = { action: 'arm' as const, label: 'Measure next reply', primary: true };
  const blocked = input.paused ? 'Resume monitoring to measure a reply.' : !input.completions ? `${rt} doesn’t report replies, so Next reply can’t measure one.`
    : !state ? 'Next reply needs an open chat in OpenChamber.' : null;
  if (blocked) return { state: 'unavailable', chip: null, note: blocked, time: null, result: null, actions: [] };
  const base = { chip: null, time: null, result: null };
  switch (state!.kind) {
    case 'idle': return { ...base, state: 'idle', note, actions: [arm] };
    case 'offer-watch': return { ...base, state: 'offer-watch', note: 'Choose this chat’s server to measure its next reply.', actions: [{ action: 'watch', label: `Watch ${state!.runtime}` }] };
    case 'armed': return { ...base, state: 'armed', chip: ARMED, note, time: { value: mmss(Math.max(0, REPLY_WAIT_MS - (input.now - state!.at))), suffix: ' left' },
      actions: [{ action: 'cancel', label: 'Cancel' }] };
    case 'measuring': return { ...base, state: 'measuring', note: 'Measuring next reply', time: { value: dur(Math.max(0, input.now - state!.startedAt)), suffix: '' },
      actions: [{ action: 'cancel', label: 'Cancel' }] };
    case 'cancelled': return { ...base, state: 'cancelled', note: CANCELLED[state!.reason], actions: [arm] };
    // Won't arm: the chat's model differs or is unknown, or the runtime can't count requests.
    case 'refused': return { ...base, state: 'unavailable', note: `Next reply can’t measure this chat: ${(input.text ?? HISTORY_TEXT).withheld(state!.reason).replace(/^All server activity · /, '')}.`, actions: [] };
    case 'result': {
      const capture = nextReplyCapture(state!, input.runtime, input.now), m = capture.measurements, rate = captureRate(capture);
      const values = [rate ? value(`${tps(rate.tps)} tok/s`, rate.basis) : null, m.outputTokens !== undefined ? value(`${int(m.outputTokens)} out`, 'reported') : null,
        m.ttftMs !== undefined ? value(`First token ${dur(m.ttftMs)}`, 'reported') : null].filter((item): item is ValueView => item !== null);
      const split = [value(`Turn ${dur(m.wholeMs!)}`, 'observed'), m.modelMs !== undefined && m.toolMs !== undefined ? value(`Model · tool ${dur(m.modelMs)} · ${dur(m.toolMs)}`, 'observed') : null]
        .filter((item): item is ValueView => item !== null);
      // A failed step keeps its own reason, so the chip says why the reply stayed server-wide.
      const reason = state!.steps.find(step => step.verdict?.attr === 'withheld')?.verdict?.reason ?? 'not-observed';
      const chip: AttrChip = state!.attributed ? ARMED : { attr: 'server', text: (input.text ?? HISTORY_TEXT).withheld(reason), reason };
      return { ...base, state: 'result', note: state!.attributed ? 'Recorded with Measure next reply.' : 'A step couldn’t be matched to this chat. Readings cover all server activity.',
        result: { chip, ago: ago(state!.endedAt, input.now), values, split },
        actions: [...input.nextSaved ? [] : [{ action: 'save-next' as const, label: 'Save to Captures' }], { ...arm, label: 'Measure again', primary: false }] };
    }
  }
};
const presentWindow = (input: CapturesInput): WindowCard => {
  const w = input.window, rate = windowRate(w);
  if (!w) return { status: 'idle', lengthMs: input.windowLength, state: 'All server activity', progress: null, values: [], canSave: false };
  const elapsed = w.endedAt - w.startedAt, values = [
    rate !== null ? value(`${tps(rate)} tok/s`, 'observed', 'measured output') : value('No output speed', 'observed', 'needs one request generating'),
    value(`${int(w.decodeTokens)} out`, 'observed'), value(`${int(w.completions)} ${w.completions === 1 ? 'reply' : 'replies'} finished`, 'observed'),
    ...w.cpuMean !== null ? [value(`CPU ${pct(w.cpuMean)} average`, 'observed', 'recorded')] : [],
    ...w.memPeakBytes !== null ? [value(`RAM ${gibText(w.memPeakBytes)} peak`, 'observed', 'recorded')] : [],
  ];
  return { status: w.status, lengthMs: w.targetMs, values, canSave: w.status !== 'recording' && w.samples > 0,
    progress: w.status === 'recording' ? Math.min(100, elapsed / w.targetMs * 100) : null,
    state: w.status === 'recording' ? `${Math.floor(elapsed / 1000)} / ${w.targetMs / 1000} s` : w.status === 'finished' ? `Captured · ${dur(elapsed)}`
      : `Partial · ${w.stopReason ?? 'stopped'}` };
};
const rows = (list: readonly CaptureV2[], input: CapturesInput, legacy: boolean, reference: CaptureV2 | null, text: HistoryText): SavedRow[] => list.map(capture => {
  const rate = captureRate(capture), key = captureKey(capture, legacy), ref = reference && captureRate(reference);
  const at = new Date(capture.savedAt), today = at.toDateString() === new Date(input.now).toDateString();
  return { key, iso: at.toISOString(), title: title(capture), chip: labelChip(capture.label, text), comparing: key === input.reference,
    at: today ? at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    rate: rate ? value(`${tps(rate.tps)} tok/s`, rate.basis) : null,
    delta: rate && ref && reference !== capture ? value(`${delta(rate.tps / ref.tps)} vs reference`, 'derived') : null };
});

export const presentCaptures = (input: CapturesInput): CapturesView => {
  const text = input.text ?? HISTORY_TEXT;
  // A 1.x capture copied into capture.v2 by the migration shows once, in the read-only 1.x list.
  const migrated = new Set(input.legacy.map(capture => capture.savedAt));
  const saved = input.saved.filter(capture => !migrated.has(capture.savedAt)).sort((a, b) => b.savedAt - a.savedAt).slice(0, CAPTURE_LIMIT);
  const legacy = [...input.legacy].sort((a, b) => b.savedAt - a.savedAt);
  const reference = [...saved.map(c => [captureKey(c), c] as const), ...legacy.map(c => [captureKey(c, true), c] as const)].find(([key]) => key === input.reference)?.[1] ?? null;
  return {
    next: presentNext(input), window: presentWindow(input),
    saved: { right: `${saved.length} of ${CAPTURE_LIMIT} · oldest replaced when full`, rows: rows(saved, input, false, reference, text), share: saved.length > 0,
      empty: saved.length ? null : 'Nothing saved yet. Save a Next reply or a window to compare it later.' },
    legacy: legacy.length ? { right: 'Read-only · kept until MLX Scope 2.1', rows: rows(legacy, input, true, reference, text) } : null,
  };
};

/** Copy and Add to chat draft: runtime kinds and numbers only, through the one sanitizer. */
export const capturesReport = (captures: readonly CaptureV2[], version: string, forbidden: readonly string[]): string => {
  const line = (capture: CaptureV2): string => {
    const m = capture.measurements, rate = captureRate(capture);
    return [`${new Date(capture.savedAt).toISOString()} · ${title(capture)} · ${capture.label === 'armed' ? 'Next reply' : 'all server activity'}:`,
      rate ? `${tps(rate.tps)} tok/s${rate.basis === 'reported' ? '' : ` (${basisNote(rate.basis)})`}` : 'no output speed',
      m.outputTokens !== undefined ? `${int(m.outputTokens)} output tokens` : null, m.wholeMs !== undefined ? `turn ${dur(m.wholeMs)}` : null,
      m.completions !== undefined ? `${int(m.completions)} replies finished` : null, m.cpuMeanFraction !== undefined ? `CPU average ${pct(m.cpuMeanFraction)}` : null,
      m.memPeakBytes !== undefined ? `RAM peak ${gibText(m.memPeakBytes)}` : null].filter(Boolean).join(' ');
  };
  const text = [`MLX Scope ${version} — saved captures`,
    'Readings cover all server activity unless marked “Next reply”. Other apps and chats can affect comparisons. No model names.',
    ...captures.map(line)].join('\n');
  return clamp(redact(text, forbidden), SCOPE_TEXT_MAX_CHARS);
};
