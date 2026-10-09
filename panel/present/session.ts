import type { Severity } from '../../src/contract/alerts.ts';
import type { Basis } from '../../src/contract/capabilities.ts';
import { sameModel } from '../attribution/join.ts';
import { prefillReading } from '../progress.ts';
import { alertCopy, APPROVAL, RESTART, statusGlanceNote, withheldWhy } from './copy.ts';
import { ago, dur, mmss, tps } from './format.ts';
import { visibleAlerts } from './parts.ts';
import { glanceModel } from './scope.ts';
import { presentSpeeds, type SpeedsView } from './speeds.ts';
import type { StatusSectionInput } from './status.ts';

/** One relevant measurement, with its scope always visible beside the number. */
export interface SessionMeasurement {
  label: string; text: string; unit: string | null; basis: Basis;
  detail: string; live: boolean; kind: 'speed' | 'progress';
}
export interface SessionSectionView {
  mode: 'summary' | 'non-local'; height: number; phase: string; tone: 'normal' | 'warning' | 'critical';
  measurementScope: 'chat' | 'engine'; measurement: SessionMeasurement | null;
  speeds: SpeedsView;
  progress: { text: string; detail: string; basis: Basis } | null;
  value: { text: string; unit: string | null; basis: Basis } | null;
  model: string | null; modelTitle: string | null;
  scope: { text: string; detail: string | null; attr: 'inferred' | 'armed' | 'server' } | null;
  age: string | null; note: string | null;
  alert: { label: string; value: string; severity: Severity; more: number } | null;
  cancelMeasurement: boolean;
}
const positive = (value: number | null | undefined): value is number => value != null && Number.isFinite(value) && value > 0;

export const presentSessionSection = (input: StatusSectionInput): SessionSectionView => {
  const snapshot = input.snapshot, next = input.next, measurementScope = input.measurementScope ?? 'chat';
  const engine = measurementScope === 'engine';
  const nonLocal = !engine && input.chatIsLocal === false;
  const speeds: SpeedsView = nonLocal ? { phase: input.chatActivity === 'busy' ? 'Working' : 'Ready', model: null,
    speeds: [], averageTitle: '', averageNote: '', source: 'Chat delivery' } : presentSpeeds(input);
  const frame = input.reading.body === null ? input.reading.reason : null;
  const fresh = snapshot !== null && input.fresh !== false && !input.paused && !frame;
  const usable = !nonLocal && fresh && snapshot.status.state === 'ready' && snapshot.status.reason === null;
  const candidate = snapshot?.chat;
  const chat = !engine && fresh && candidate && candidate.observedAtMs <= input.now && candidate.expiresAtMs > input.now ? candidate : null;
  const readingPrompt = usable && snapshot.runtime.phase === 'prefill' && (!chat || chat.phase === 'waiting');
  const chatStopped = chat && (['tool', 'cancelled', 'complete'].includes(chat.phase) || chat.phase === 'waiting' && !readingPrompt);
  const matched = !engine && input.attribution.kind !== 'server-wide' && snapshot?.connection.runtime !== 'splash';
  const source = matched ? 'Chat · matched' : 'Engine';
  const sourceDetail = matched ? 'The runtime request matches this chat; another request using the same model cannot be ruled out.'
    : !engine && input.attribution.kind === 'server-wide' ? `Whole engine · ${withheldWhy(input.attribution.reason)}` : 'All requests on this engine';
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
    progress = { text: `${reading.completed.replace(' complete', '')}${reading.stale ? ' (last seen)' : ''}`,
      detail: `Prompt read${reading.stale ? ' · last seen' : ''}${reading.counts ? ` · ${reading.counts.done} of ${reading.counts.total} tokens` : ''}`,
      basis: snapshot!.capabilities['request.prefillProgress']?.basis ?? 'reported' };
    measurement = { label: `${source} · prompt`, ...progress, unit: null, live: !reading.stale, kind: 'progress' };
  } else if (usable && !chatStopped && matched && activeSpeed?.value !== null && activeSpeed) {
    measurement = { label: source, text: activeSpeed.value!, unit: 'tok/s', basis: activeSpeed.basis,
      detail: `${sourceDetail} ${activeSpeed.detail}`, live: true, kind: 'speed' };
  } else if (chat?.freshness === 'live' && ['generating', 'reasoning'].includes(chat.phase) && positive(chat.tokensPerSecond)) {
    measurement = { label: 'Chat · est.', text: tps(chat.tokensPerSecond), unit: 'tok/s', basis: 'estimate', live: true, kind: 'speed',
      detail: `Estimated delivery over ${dur(chat.observation.endedAtMs - chat.observation.startedAtMs)}${chat.basis === 'calibrated-characters' ? ' · calibrated from reported output' : ' · four characters per token'}. Includes observable reasoning${nonLocal ? ', network delivery and provider buffering' : ''}.` };
  } else if (usable && !chatStopped && activeSpeed?.value !== null && activeSpeed) {
    measurement = { label: 'Engine', text: activeSpeed.value!, unit: 'tok/s', basis: activeSpeed.basis,
      detail: `All engine requests · ${activeSpeed.detail}`, live: true, kind: 'speed' };
  }
  if (chat) {
    phase = readingPrompt ? 'Reading prompt' : { generating: 'Generating', reasoning: 'Reasoning', tool: 'Using tools', waiting: 'Waiting', complete: 'Complete', cancelled: 'Stopped' }[chat.phase];
    if (chat.phase === 'complete' && positive(chat.tokensPerSecond)) {
      measurement = { label: 'Last chat · avg.', text: tps(chat.tokensPerSecond), unit: 'tok/s', basis: 'derived', live: false, kind: 'speed',
        detail: `Reported output tokens divided by observed step duration. This completed-step average includes waiting before delivery${nonLocal ? '; it is not the cloud engine’s internal speed' : ''}.` };
      age = ago(chat.observedAtMs, input.now);
    }
  }
  // A completed value is intentionally a last result, never promoted back into the live speed.
  const last = input.last, cancelled = !engine && (input.window?.outcome === 'failure' || chat?.phase === 'cancelled');
  const lastMatches = engine || !input.sessionModel || sameModel(input.sessionModel, last?.completion.model ?? null);
  if (!measurement && usable && !cancelled && !chatStopped && snapshot.runtime.phase === 'idle' && (engine || input.chatActivity !== 'busy')
    && last && lastMatches && positive(last.completion.decodeTps) && last.completion.basis !== 'last-observed') {
    const lastMatched = !engine && last.label.kind !== 'server-wide' && snapshot.connection.runtime !== 'splash';
    measurement = { label: `Last ${lastMatched ? 'chat · matched' : 'engine'} · avg.`, text: tps(last.completion.decodeTps), unit: 'tok/s',
      basis: last.completion.basis, live: false, kind: 'speed', detail: `Completed request average · ${ago(last.completion.finishedAt, input.now)}` };
    age = ago(last.completion.finishedAt, input.now);
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
  const model = !engine && input.sessionModel ? input.sessionModel : speeds.model;
  const scope = measurement ? { text: measurement.label, detail: measurement.detail, attr: measurement.label.includes('chat') || measurement.label.startsWith('Chat') ? 'inferred' as const : 'server' as const }
    : { text: engine ? 'Whole engine' : 'This chat', detail: sourceDetail, attr: matched ? 'inferred' as const : 'server' as const };
  // Missing readings leave the activity area's geometry intact without inventing a measurement row.
  return { mode: 'summary', height: 76 + (!nonLocal && (alert || note) ? 24 : 0),
    measurementScope, measurement, speeds, progress,
    phase, tone: alert?.severity === 'critical' ? 'critical' : input.fresh === false || alert || frame ? 'warning' : 'normal',
    value: !measurement ? null : { text: measurement.text, unit: measurement.unit, basis: measurement.basis },
    model: nonLocal || !model ? null : glanceModel(model), modelTitle: nonLocal ? null : model,
    scope: nonLocal ? { text: 'This chat', detail: 'Delivery observed in the selected chat', attr: 'inferred' } : scope,
    age, note: nonLocal ? null : note, alert,
    cancelMeasurement: !nonLocal && (next?.kind === 'armed' || next?.kind === 'measuring') };
};
