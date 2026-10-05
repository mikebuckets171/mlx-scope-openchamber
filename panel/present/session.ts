import type { Severity } from '../../src/contract/alerts.ts';
import type { Basis } from '../../src/contract/capabilities.ts';
import { SEVERITY_WORD } from './copy.ts';
import { attrChip, visibleAlerts } from './parts.ts';
import { modelOf } from './scope.ts';
import { presentGlance, type StatusSectionInput } from './status.ts';

/** The Session sidebar is a summary. Detailed measurements remain in the full Scope panel. */
export interface SessionSectionView {
  mode: 'summary' | 'non-local';
  height: number;
  phase: string;
  tone: 'normal' | 'warning' | 'critical';
  value: { text: string; unit: string | null; basis: Basis } | null;
  model: string | null;
  modelTitle: string | null;
  scope: { text: string; detail: string | null; attr: 'inferred' | 'armed' | 'server' } | null;
  age: string | null;
  note: string | null;
  alert: { label: string; value: string; severity: Severity; more: number } | null;
  cancelMeasurement: boolean;
}

export const presentSessionSection = (input: StatusSectionInput): SessionSectionView => {
  // A saved Turn stats preference must not replace current activity with an empty or older reply.
  const view = presentGlance({ ...input, expanded: false, tipDismissed: true, firstRunDismissed: true });
  const glance = view.glance!, line = glance.line1, second = glance.line2;
  let phase = line.title ?? line.word ?? (line.dot === 'prefill' ? 'Reading prompt' : line.rate ? 'Generating' : 'Working');
  if (phase === 'Live') phase = input.snapshot?.runtime.phase === 'decode' ? 'Generating' : 'Server activity';
  const value = line.rate !== null ? { text: line.rate, unit: line.unit, basis: line.rateBasis }
    : second?.kind === 'prefill' ? { text: second.percent, unit: null, basis: 'reported' as const } : null;
  let note: string | null = second?.kind === 'note' ? second.text : null;
  if (second?.kind === 'prefill' && second.eta) note = `About ${second.eta} left · estimate`;
  if (second?.kind === 'armed') note = `Waiting for your next reply · ${second.left} left`;
  if (second?.kind === 'measuring') note = `Measuring next reply · ${second.elapsed}`;
  // Without a current rate the older glance can carry the last reply's source. Current activity
  // must use the current attribution, even when only the runtime's phase is available.
  const currentActivity = !line.title && !value && input.snapshot
    && ['decode', 'prefill', 'processing', 'queued'].includes(input.snapshot.runtime.phase)
    && second?.kind !== 'armed' && second?.kind !== 'measuring';
  const source = currentActivity ? attrChip(input.attribution, true) : line.chip;
  const scope = source?.attr ? {
    text: source.attr === 'server' ? 'Server-wide' : source.text,
    detail: source.attr === 'server' ? source.reason ?? (second?.kind === 'spark' ? second.reason : null) : null,
    attr: source.attr,
  } : null;
  const age = phase === 'Last reply' && value ? line.since : null;
  const modelTitle = line.model ? (phase === 'Last reply' ? input.last?.completion.model : null)
    ?? (input.snapshot ? modelOf(input.snapshot) : null) ?? line.model : null;
  const alert = glance.alert ? {
    label: glance.alert.text.startsWith('macOS memory pressure:') ? 'Memory pressure' : glance.alert.text,
    value: SEVERITY_WORD[glance.alert.severity], severity: glance.alert.severity,
    more: Math.max(0, (input.snapshot ? visibleAlerts(input.snapshot).length : 1) - 1),
  } : null;
  const nonLocal = view.mode === 'non-local';
  // Each row has a fixed rhythm, with up to two lines for a connection/status explanation.
  const height = nonLocal ? 24 : 8 + 24 + (line.model ? 24 : 0) + (scope || age ? 20 : 0)
    + (note ? 36 : 0) + (alert ? 24 : 0) + 28;
  return { mode: nonLocal ? 'non-local' : 'summary', height, phase,
    tone: line.dot === 'bad' ? 'critical' : line.dot === 'warn' ? 'warning' : 'normal',
    value, model: line.model, modelTitle, scope, age, note, alert,
    cancelMeasurement: second?.kind === 'armed' || second?.kind === 'measuring' };
};
