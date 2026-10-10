import type { Severity } from '../../src/contract/alerts.ts';
import type { Basis } from '../../src/contract/capabilities.ts';
import { sameModel } from '../attribution/join.ts';
import { prefillReading } from '../progress.ts';
import { alertCopy, APPROVAL, RESTART, statusGlanceNote } from './copy.ts';
import { ago, dur, kt, mmss, size, tps } from './format.ts';
import { visibleAlerts } from './parts.ts';
import { presentSpeeds, type SpeedsView } from './speeds.ts';
import type { StatusSectionInput } from './status.ts';

/** One relevant measurement, with its scope always visible beside the number. */
export interface SessionMeasurement {
  label: string; text: string; unit: string | null; basis: Basis;
  detail: string; live: boolean; kind: 'speed' | 'progress' | 'elapsed';
  result?: { label: string; outputTokens?: number; durationMs?: number; ttftMs?: number; timing: 'request' | 'step' };
}
export interface SessionSectionView {
  phase: string; tone: 'normal' | 'warning' | 'critical';
  measurementScope: 'chat' | 'engine'; measurement: SessionMeasurement | null;
  support: { text: string; detail: string; basis?: Basis } | null;
  speeds: SpeedsView;
  progress: { text: string; detail: string; basis: Basis } | null;
  /** The previous completed average, dimmed below a live reading until a new one replaces it. Never live. */
  held: { text: string; detail: string } | null;
  /** At rest with nothing true to show: the glance folds its empty rows instead of leaving a blank block. */
  resting: boolean;
  note: string | null;
  alert: { label: string; value: string; severity: Severity; more: number } | null;
  cancelMeasurement: boolean;
}
const positive = (value: number | null | undefined): value is number => value != null && Number.isFinite(value) && value > 0;
/** Phases where nothing is happening; anything mid-turn keeps its reserved rows so the glance never jumps during a reply. */
const RESTING = new Set(['Idle', 'Ready', 'No model loaded', 'Connected', 'Paused']);
/** Whole seconds, rounded down: an elapsed time never runs ahead of the clock. */
const elapsedText = (ms: number): string => (ms < 60_000 ? `${Math.floor(ms / 1_000)} s` : dur(Math.floor(ms / 1_000) * 1_000)).replace(/ /g, '\u00a0');
type SessionSectionInput = Omit<StatusSectionInput, 'turn' | 'vsUsual' | 'sparkline' | 'expanded' | 'tipDismissed'> & Partial<StatusSectionInput>;

export const presentSessionSection = (input: SessionSectionInput): SessionSectionView => {
  const snapshot = input.snapshot, next = input.next, measurementScope = input.measurementScope ?? 'chat';
  const engine = measurementScope === 'engine';
  const nonLocal = !engine && input.chatIsLocal === false;
  const speeds: SpeedsView = nonLocal ? { phase: input.chatActivity === 'busy' ? 'Working' : 'Ready', model: null,
    speeds: [], averageTitle: '', averageNote: '', source: 'Chat delivery' } : presentSpeeds(input);
  const frame = input.reading.body === null ? input.reading.reason : null;
  const fresh = snapshot !== null && input.fresh !== false && !input.paused && !frame;
  const usable = !nonLocal && fresh && snapshot.status.state === 'ready' && snapshot.status.reason === null;
  const candidate = snapshot?.chat;
  const observedChat = candidate && candidate.observedAtMs <= input.now && candidate.expiresAtMs > input.now ? candidate : null;
  const retained = input.lastChat?.freshness === 'last' && input.lastChat.observedAtMs <= input.now && input.chatActivity === 'idle' ? input.lastChat : null;
  // Cloud delivery is its own scope: it is shown as a cloud estimate and never borrows a local engine reading.
  const chat = !engine && fresh ? observedChat ?? retained : null;
  const readingPrompt = usable && snapshot.runtime.phase === 'prefill' && (!chat || chat.phase === 'waiting');
  const chatStopped = chat && (['tool', 'cancelled', 'complete'].includes(chat.phase) || chat.phase === 'waiting' && !readingPrompt);
  const matched = !engine && input.attribution.kind !== 'server-wide' && snapshot?.connection.runtime !== 'splash';
  const source = matched ? 'Chat · matched' : 'Engine';
  const sourceDetail = 'Runtime match to this chat; other requests with this model remain possible.';
  let phase = speeds.phase === 'Status stale' ? 'Waiting for update' : speeds.phase === 'Not admitting' ? 'Not accepting requests'
    : snapshot?.status.reason === 'admin_unauthorized' ? 'Limited access' : speeds.phase;
  let measurement: SessionMeasurement | null = null, progress: SessionSectionView['progress'] = null, age: string | null = null;
  let note: string | null = null;
  // Companion events can arrive before the runtime's next poll. A previous prefill reading is not output speed.
  const runtimePhaseAgrees = !chat || !['generating', 'reasoning'].includes(chat.phase) || snapshot?.runtime.phase === 'decode';
  const activeSpeed = runtimePhaseAgrees ? speeds.speeds.find(speed => speed.key === 'generation' && speed.value !== null)
    ?? speeds.speeds.find(speed => speed.value !== null) : undefined;
  const reading = readingPrompt && snapshot!.capabilities['request.prefillProgress'] ? prefillReading(input.reading) : null;
  if (reading?.percent != null) {
    progress = { text: reading.completed.replace(' complete', ''),
      detail: `Prompt read${reading.stale ? ' · last seen' : ''}${reading.counts ? ` · ${reading.counts.done} of ${reading.counts.total} tokens` : ''}`,
      basis: snapshot!.capabilities['request.prefillProgress']?.basis ?? 'reported' };
    measurement = { label: `${source} · prompt${reading.stale ? ' · last seen' : ''}`, ...progress, unit: null, live: !reading.stale, kind: 'progress' };
  } else if (usable && !chatStopped && matched && activeSpeed?.value !== null && activeSpeed) {
    measurement = { label: source, text: activeSpeed.value!, unit: 'tok/s', basis: activeSpeed.basis,
      detail: `${sourceDetail} ${activeSpeed.detail}`, live: true, kind: 'speed' };
  } else if (chat?.freshness === 'live' && ['generating', 'reasoning'].includes(chat.phase) && positive(chat.tokensPerSecond)) {
    measurement = { label: nonLocal ? 'Cloud · est.' : 'Chat · est.', text: tps(chat.tokensPerSecond), unit: 'tok/s', basis: 'estimate', live: true, kind: 'speed',
      detail: `Estimated delivery over ${dur(chat.observation.endedAtMs - chat.observation.startedAtMs)}${chat.basis === 'calibrated-characters' ? ' · calibrated from reported output' : ' · four characters per token'}. Includes observable reasoning${nonLocal ? ', network delivery and provider buffering' : ''}.` };
  } else if (usable && !chatStopped && activeSpeed?.value !== null && activeSpeed) {
    measurement = { label: 'Engine', text: activeSpeed.value!, unit: 'tok/s', basis: activeSpeed.basis,
      detail: `All engine requests · ${activeSpeed.detail}`, live: true, kind: 'speed' };
  }
  if (chat) {
    phase = readingPrompt ? 'Reading prompt' : chat.phase === 'complete' && input.chatActivity === 'busy' ? 'Waiting'
      : { generating: 'Generating', reasoning: 'Reasoning', tool: 'Using tools', waiting: 'Waiting', complete: 'Complete', cancelled: 'Stopped' }[chat.phase];
    if (chat.phase === 'complete' && input.chatActivity !== 'busy' && positive(chat.tokensPerSecond)) {
      measurement = { label: nonLocal ? 'Last cloud · avg.' : 'Last chat · avg.', text: tps(chat.tokensPerSecond), unit: 'tok/s', basis: 'derived', live: false, kind: 'speed',
        detail: `Reported output tokens divided by observed step duration, including waiting before delivery${nonLocal ? '; cloud engine timing is unknown' : ''}.`,
        result: { label: nonLocal ? 'Last cloud result' : 'Last chat result', durationMs: chat.observation.endedAtMs - chat.observation.startedAtMs, timing: 'step' } };
      age = ago(chat.observedAtMs, input.now);
    }
  }
  // A completed value is intentionally a last result, never promoted back into the live speed.
  const last = input.last, cancelled = !engine && (input.window?.outcome === 'failure' || chat?.phase === 'cancelled');
  const lastMatches = engine || !input.sessionModel || sameModel(input.sessionModel, last?.completion.model ?? null);
  if (!measurement && usable && !cancelled && !chatStopped && snapshot.runtime.phase === 'idle' && (engine || input.chatActivity !== 'busy')
    && last && lastMatches && positive(last.completion.decodeTps) && last.completion.basis !== 'last-observed') {
    const window = input.window;
    const lastMatched = !engine && last.label.kind !== 'server-wide' && snapshot.connection.runtime !== 'splash'
      && window && last.completion.startedAt !== null && last.completion.startedAt >= (window.startedAt ?? window.joinedAt ?? Infinity)
      && last.completion.finishedAt <= (window.endedAt ?? input.now);
    measurement = { label: `Last ${lastMatched ? 'chat · matched' : 'engine'} · avg.`, text: tps(last.completion.decodeTps), unit: 'tok/s',
      basis: last.completion.basis, live: false, kind: 'speed', detail: `Completed request average · ${ago(last.completion.finishedAt, input.now)}`,
      result: { label: `Last ${lastMatched ? 'chat · matched' : 'engine'} result`, timing: 'request',
        outputTokens: last.completion.outputTokens, ttftMs: last.completion.ttftMs,
        ...last.completion.startedAt !== null ? { durationMs: last.completion.finishedAt - last.completion.startedAt } : {} } };
    age = ago(last.completion.finishedAt, input.now);
  }
  // Never dark: while the prompt is read, or the reply waits for its first output, and nothing better is measured, the
  // hero holds this reply's elapsed time. It comes from the engine's own request clock when it reports one, else from
  // the chat's observed turn start; a turn joined mid-way has no known start, so nothing is shown. Never a simulated %.
  const awaitingOutput = readingPrompt || !engine && chat?.phase === 'waiting' && input.chatActivity === 'busy';
  if (!measurement && !cancelled && awaitingOutput && fresh) {
    const request = snapshot.runtime.request, engineClock = readingPrompt && request?.elapsedMs != null ? snapshot.capabilities['request.elapsed'] : undefined;
    const turn = !engine && input.window?.endedAt === null && input.window.startedAt !== null && input.window.startedAt <= input.now ? input.window.startedAt : null;
    if (engineClock && request!.elapsedMs! >= 0) measurement = { label: `${source} · prompt · elapsed`, text: elapsedText(request!.elapsedMs!), unit: null,
      basis: engineClock.basis, live: true, kind: 'elapsed', detail: 'Time since the engine started this request. Prompt progress is not reported.' };
    else if (turn !== null) measurement = { label: `This reply · elapsed`, text: elapsedText(input.now - turn), unit: null, basis: 'observed', live: true,
      kind: 'elapsed', detail: readingPrompt ? 'Time since this reply started. The engine does not report prompt progress.' : 'Time since this reply started, waiting for its first output.' };
  }
  if (cancelled && !engine) { measurement = null; phase = 'Stopped'; }
  else if (!engine && input.chatActivity === 'busy' && usable && !chat && snapshot.runtime.phase === 'idle') phase = 'Waiting';
  if (frame === 'needs_approval') { phase = 'Needs approval'; note = APPROVAL.glance; }
  else if (frame === 'contract_mismatch') { phase = 'Needs restart'; note = RESTART.glance; }
  else if (frame) { phase = 'Reconnecting'; note = input.reading.message; }
  else if (input.paused) phase = 'Paused';
  else if (input.fresh === false) phase = 'Waiting for update';
  else if (snapshot && (snapshot.status.reason !== null || snapshot.status.state !== 'ready')) {
    note = snapshot.status.reason === 'status_stale' ? 'Checking again automatically'
      : snapshot.status.reason === 'admin_unauthorized' ? 'Check access in MLX Scope'
        : snapshot.status.reason === 'metrics_required' ? 'Open MLX Scope for setup' : statusGlanceNote(snapshot);
  } else if (next?.kind === 'armed') note = `Next reply armed · ${mmss(Math.max(0, 120_000 - (input.now - next.at)))} left`;
  else if (next?.kind === 'measuring') note = `Recording reply · ${dur(input.now - next.startedAt)}`;
  else if (!measurement && speeds.speeds.some(speed => speed.detail.startsWith('Turn off Energy'))) note = 'Energy saving is on';
  const top = !nonLocal && fresh && snapshot ? visibleAlerts(snapshot)[0] : null;
  const text = top ? alertCopy(top.id, top.params)[0] : '';
  const alert = top ? { label: text.startsWith('macOS memory pressure:') ? `Memory pressure · ${top.severity}` : text,
    value: '', severity: top.severity, more: 0 } : null;
  // Keep the one priority warning; repeated setup explanations remain in the full panel.
  if (alert) note = null;
  const request = usable ? snapshot.runtime.request : null;
  const prefix = measurement?.label.startsWith('Chat · matched') ? '' : 'Engine · ';
  const output = measurement?.live && runtimePhaseAgrees && usable && ['decode', 'processing'].includes(snapshot.runtime.phase);
  const support = alert || !fresh || cancelled ? null : age && measurement ? { text: `Finished ${age}`, detail: measurement.detail }
    : reading?.counts && measurement?.live ? { text: `${prefix}${kt(reading.counts.done)} / ${kt(reading.counts.total)} tokens`, detail: progress!.detail }
    : output && request?.ttftMs != null && snapshot!.capabilities['request.ttft'] ? { text: `${prefix}First token ${dur(request.ttftMs)}`, detail: 'Time to first token for this engine request.', basis: snapshot!.capabilities['request.ttft']!.basis }
    : output && request?.outputTokens != null ? { text: `${prefix}${kt(request.outputTokens)} tokens out`, detail: 'Output so far for this engine request.', basis: snapshot!.capabilities['request.tokens']?.basis }
    : usable && !chatStopped && snapshot.runtime.server.active! > 1 ? { text: `Engine · ${snapshot.runtime.server.active} active`, detail: 'Concurrent requests reported by this engine.' } : null;
  // Held below a live reading: the previous completed average of this local chat's model. A cloud chat never borrows
  // a local engine's reply, and a value is never held across a model change or cancellation.
  const held = !nonLocal && fresh && !alert && !cancelled && measurement?.live && last && lastMatches && positive(last.completion.decodeTps)
    && last.completion.basis !== 'last-observed' && last.completion.finishedAt <= input.now
    ? { text: `Last ${!engine && last.label.kind !== 'server-wide' && snapshot!.connection.runtime !== 'splash' ? 'reply' : 'engine reply'} · ${tps(last.completion.decodeTps)} tok/s · ${ago(last.completion.finishedAt, input.now)}`,
      detail: 'The previous completed average, held until a new one replaces it. Not a live reading.' } : null;
  // At rest the glance keeps its shape with the engine's own record — its overall average and what it holds — instead
  // of empty rows. It is labelled and never live, needs a fresh local reading, and a cloud chat never borrows it.
  // Local engine notes never describe a cloud chat; a frame problem still does.
  const shownNote = nonLocal && !frame ? null : note;
  const atRest = RESTING.has(phase) && !alert && !cancelled && !frame && !shownNote;
  let restingSupport: SessionSectionView['support'] = null;
  if (input.restingFacts && atRest && usable && !measurement && !support) {
    const server = snapshot.runtime.server, memory = snapshot.runtime.memory, caps = snapshot.capabilities;
    const average = server.averages?.decodeTps, averaged = caps['server.averages'];
    if (positive(average) && averaged) measurement = { label: 'Engine · overall avg.', text: tps(average), unit: 'tok/s', basis: averaged.basis,
      live: false, kind: 'speed', detail: `Average generation speed across all requests · ${speeds.averageNote}. Not a live reading.` };
    const bytes = memory.modelBytes ?? memory.metalBytes, bytesCap = caps[memory.modelBytes != null ? 'server.memory.model' : 'server.memory.metal'];
    const firstToken = server.histograms?.ttftMs?.p50, latency = caps['server.latency'];
    const facts = [bytes != null && bytesCap ? `${size(bytes)} ${memory.modelBytes != null ? 'model' : 'GPU'} memory` : null,
      firstToken != null && latency ? `first token ${dur(firstToken)}` : null].filter((fact): fact is string => fact !== null);
    if (facts.length) restingSupport = { text: facts.join(' · '), detail: 'What the engine holds now and its typical first-token time across recent requests.' };
  }
  const shownSupport = support ?? restingSupport;
  // Missing readings leave the activity area's geometry intact without inventing a measurement row.
  return { measurementScope, measurement, support: shownSupport, speeds, progress, held,
    resting: atRest && !measurement && !shownSupport && !held,
    phase, tone: alert?.severity === 'critical' ? 'critical' : input.fresh === false || alert || frame ? 'warning' : 'normal',
    note: shownNote, alert,
    cancelMeasurement: !nonLocal && (next?.kind === 'armed' || next?.kind === 'measuring') };
};
