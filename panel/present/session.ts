import type { Severity } from '../../src/contract/alerts.ts';
import type { Basis } from '../../src/contract/capabilities.ts';
import { alertCopy, APPROVAL, NON_LOCAL, RESTART, SEVERITY_WORD, statusGlanceNote } from './copy.ts';
import { dur, mmss } from './format.ts';
import { attrChip, visibleAlerts } from './parts.ts';
import { glanceModel } from './scope.ts';
import { prefillReading } from '../progress.ts';
import { presentSpeeds, type SpeedsView } from './speeds.ts';
import type { StatusSectionInput } from './status.ts';

/** The host owns the Scope section heading. This instrument stays focused on current inference. */
export interface SessionSectionView {
  mode: 'summary' | 'non-local'; height: number; phase: string; tone: 'normal' | 'warning' | 'critical';
  speeds: SpeedsView;
  progress: { text: string; detail: string; basis: Basis };
  value: { text: string; unit: string | null; basis: Basis } | null;
  model: string | null; modelTitle: string | null;
  scope: { text: string; detail: string | null; attr: 'inferred' | 'armed' | 'server' } | null;
  age: string | null; note: string | null;
  alert: { label: string; value: string; severity: Severity; more: number } | null;
  cancelMeasurement: boolean;
}
export const presentSessionSection = (input: StatusSectionInput): SessionSectionView => {
  const speeds = presentSpeeds(input), snapshot = input.snapshot, next = input.next;
  const measuring = next?.kind === 'armed' || next?.kind === 'measuring';
  const source = attrChip(snapshot?.connection.runtime === 'splash' ? { kind: 'server-wide', reason: 'all-requests' }
    : measuring ? { kind: 'armed' } : input.attribution, true);
  const alerts = snapshot ? visibleAlerts(snapshot) : [], top = alerts[0];
  const text = top ? alertCopy(top.id, top.params)[0] : '';
  const alert = top ? { label: text.startsWith('macOS memory pressure:') ? 'Memory pressure' : text,
    value: SEVERITY_WORD[top.severity], severity: top.severity, more: alerts.length - 1 } : null;
  const frame = input.reading.body === null ? input.reading.reason : null;
  const plainNote = snapshot?.status.reason === 'status_stale' ? 'Checking again automatically'
    : snapshot?.status.reason === 'admin_unauthorized' ? 'Check access in MLX Scope'
      : snapshot?.status.reason === 'metrics_required' ? 'Open MLX Scope for setup' : null;
  const note = frame === 'needs_approval' ? APPROVAL.glance : frame === 'contract_mismatch' ? RESTART.glance
    : speeds.speeds.some(speed => speed.detail.startsWith('Turn off Energy')) ? 'Turn off Energy saving to see speeds' : next?.kind === 'armed' ? `Waiting for your next reply · ${mmss(Math.max(0, 120_000 - (input.now - next.at)))} left`
      : next?.kind === 'measuring' ? `Measuring next reply · ${dur(input.now - next.startedAt)}` : frame ? input.reading.message
        : snapshot && (snapshot.status.reason !== null || snapshot.status.state !== 'ready') ? plainNote ?? statusGlanceNote(snapshot) : null;
  const nonLocal = input.chatIsLocal === false;
  const primary = speeds.speeds.find(speed => speed.value !== null);
  const current = snapshot && input.fresh !== false && !input.paused && snapshot.status.state === 'ready' && snapshot.status.reason === null;
  const progress = current && snapshot.capabilities['request.prefillProgress'] ? prefillReading(input.reading) : null;
  const percent = progress?.percent != null ? progress.completed.replace(' complete', '') : null;
  const progressView = { text: percent !== null ? `${percent}${progress!.stale ? ' (last seen)' : ''}`
    : input.paused ? 'Paused' : input.fresh === false ? 'Updating…' : current && (snapshot.runtime.phase === 'prefill' || speeds.speeds[0]!.value !== null) ? 'Unavailable' : '—',
    detail: percent !== null ? `Prompt read${progress!.stale ? ' · last seen' : ''}${progress!.counts ? ` · ${progress!.counts.done} of ${progress!.counts.total} tokens` : ''}`
      : 'The server has not provided current prompt progress', basis: snapshot?.capabilities['request.prefillProgress']?.basis ?? 'reported' as Basis };
  const model = speeds.model ? glanceModel(speeds.model) : null;
  const phase = speeds.phase === 'Status stale' ? 'Waiting for update' : speeds.phase === 'Not admitting' ? 'Not accepting requests'
    : snapshot?.status.reason === 'admin_unauthorized' ? 'Limited access' : speeds.phase;
  const sourceText = source.attr === 'server' ? 'All server activity' : source.attr === 'inferred' ? 'Likely this chat' : 'Next reply';
  return { mode: nonLocal ? 'non-local' : 'summary', height: nonLocal ? 24 : 142 + (note ? 30 : 0) + (alert ? 24 : 0),
    phase: nonLocal ? NON_LOCAL : input.paused ? 'Paused' : frame === 'needs_approval' ? 'Needs approval' : frame === 'contract_mismatch' ? 'Needs restart' : frame ? 'Reconnecting' : phase,
    tone: nonLocal ? 'normal' : alert?.severity === 'critical' ? 'critical' : input.fresh === false || alert || frame ? 'warning' : 'normal',
    speeds, progress: progressView, value: nonLocal || !primary ? null : { text: primary.value!, unit: 'tok/s', basis: primary.basis },
    model: nonLocal ? null : model, modelTitle: nonLocal ? null : speeds.model,
    scope: nonLocal ? null : { text: sourceText, detail: source.reason ?? null, attr: source.attr! },
    age: null, note: nonLocal ? null : note, alert: nonLocal ? null : alert, cancelMeasurement: !nonLocal && measuring };
};
