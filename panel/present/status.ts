import type { Severity } from '../../src/contract/alerts.ts';
import type { Basis } from '../../src/contract/capabilities.ts';
import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import type { TrendV2 } from '../../src/contract/trend.ts';
import type { AttributionLabel } from '../attribution/join.ts';
import type { NextReplyState } from '../attribution/next-reply.ts';
import type { TurnWindow } from '../attribution/sessions.ts';
import type { TurnSummary } from '../attribution/turn.ts';
import type { VsUsual } from '../history/regress.ts';
import { niceCeil } from '../render/chart.ts';
import { alertCopy, APPROVAL, FIRST_RUN, NON_LOCAL, PRESSURE, RESTART, SEVERITY_WORD, sinceText, statusCopy, statusGlanceNote, THERMAL, THERMAL_WARN, thermalLevel, TIP, withheldWhy } from './copy.ts';
import { ago, delta, dur, int, kt, mmss, pct, tps } from './format.ts';
import { attrChip, BASIS_WORD, visibleAlerts, type Chip } from './parts.ts';
import type { Reading } from './reading.ts';
import { glanceModel, liveSplashRate, modelOf, SERVER_WIDE } from './scope.ts';

// Owner: ui-core. The Work Status section and the rail's Compact mode (plan §5.8, G2): a glance line at 56 px (80 with
// an alert, 24 for a non-local chat) and the Turn stats replacement at ≤ 200 px. Rows a runtime cannot report are left out.

export type StatusMode = 'glance' | 'turn-stats' | 'non-local';
export interface StatusSectionInput {
  now: number;
  reading: Reading;                          // frame reasons (contract_mismatch, needs_approval…) arrive here
  snapshot: SnapshotV2 | null;
  attribution: AttributionLabel;
  turn: TurnSummary | null;                  // attribution; null when withheld or not observed
  vsUsual: VsUsual | null;                   // ui-history
  sparkline: TrendV2 | null;                 // 15 min decodeTps, ui-history's client
  chatIsLocal: boolean | null;               // the open chat's provider is the monitored connection; null = unknown
  expanded: boolean;
  tipDismissed: boolean;                     // pref.v2 "Replace Turn stats" tip
  // Additions (ui-core, Stage 8): what the glance needs beyond the frozen fields. All optional; absent = not known.
  fresh?: boolean;
  paused?: boolean;
  last?: { completion: CompletionV2; label: AttributionLabel } | null;
  next?: NextReplyState;
  window?: TurnWindow | null;                // the open chat's newest turn window
  firstRun?: boolean;                        // the ledger's first write: "Recording reply history locally"
  firstRunDismissed?: boolean;
}
export interface StatusRow { label: string; value: string; basis: string | null }
export type DotTone = 'live' | 'prefill' | 'warn' | 'bad' | 'idle';
export interface Spark { path: string; label: string }
export interface GlanceLine1 { dot: DotTone; word: string | null; model: string | null; rate: string | null; rateBasis: Basis; unit: string | null; chip: Chip | null; describedBy: boolean; title: string | null; since: string | null; muted: boolean }
export type GlanceLine2 =
  | { kind: 'spark'; spark: Spark | null; size: '' | 'sm' | 'wide'; reason: string | null; last: { rate: string; basis: string | null } | null; chips: Chip[]; toggle: boolean }
  | { kind: 'prefill'; percent: string; eta: string | null; toggle: boolean }
  | { kind: 'note'; text: string }
  | { kind: 'armed'; left: string }
  | { kind: 'measuring'; elapsed: string };
export interface GlanceNotice { text: string; action: string | null; dismiss: 'tip' | 'first-run' }
export interface StatusSectionView {
  mode: StatusMode;
  height: number;                            // setHeight: 24 | 56 | 80 | ≤ 200
  rows: StatusRow[];                         // turn-stats mode only
  // Additions (ui-core): the structure the markup draws.
  glance: { metrics?: StatusRow[]; line1: GlanceLine1; line2: GlanceLine2 | null; notice: GlanceNotice | null; alert: { severity: Severity; text: string; more: number } | null } | null;
  turn: { alert?: { severity: Severity; text: string; more: number } | null; dot: DotTone; title: string; sub: string | null; chip: Chip; reason: string | null; spark: Spark | null; chips: Chip[] } | null;
}

/** The status frame's heights (G2): padding 4 + 24 px lines; the tip adds 64, the first-run notice 48; Turn stats rows are 16 px. */
export const HEIGHTS = { nonLocal: 24, glance: 56, alert: 80, firstRun: 80, tip: 96, max: 200 } as const;
const NOTICE_PX = { tip: 64, 'first-run': 48 } as const;
const glanceHeight = (line2: boolean, notice: GlanceNotice | null, alert: boolean): number =>
  8 + 24 + (line2 ? 24 : 0) + (notice ? NOTICE_PX[notice.dismiss] : 0) + (alert ? 24 : 0);
const turnHeight = (rows: number, reason: boolean): number => Math.min(HEIGHTS.max, 8 + 24 + (reason ? 16 : 0) + rows * 16 + 24);

/** The 15 min decode sparkline: a line only where buckets hold readings. Fewer than 2 readings → no chart. */
export const sparkline = (trend: TrendV2 | null): Spark | null => {
  const buckets = trend?.series.decodeTps?.buckets ?? [], read = buckets.filter(bucket => bucket !== null);
  if (read.length < 2) return null;
  const ceiling = niceCeil(Math.max(...read.map(bucket => bucket![1]))), last = buckets.length - 1 || 1;
  let path = '', open = false;
  buckets.forEach((bucket, index) => {
    if (!bucket) { open = false; return; }
    path += `${open ? 'L' : 'M'}${(index / last * 100).toFixed(1)} ${(15 - bucket[2] / ceiling * 13).toFixed(1)} `;
    open = true;
  });
  const values = read.map(bucket => bucket![2]);
  return { path: path.trim(), label: `Decode speed, last ${Math.round((trend!.windowMs) / 60_000)} min: ${tps(Math.min(...values))} to ${tps(Math.max(...values))} tokens per second` };
};

/** Chips say something or are left out: pressure and thermal when not normal, GPU busy while a request runs. */
export const glanceChips = (snapshot: SnapshotV2 | null, options: { gpu?: boolean; skip?: readonly string[] } = {}): Chip[] => {
  const host = snapshot?.host, chips: Chip[] = [], skip = options.skip ?? [];
  const pressure = host?.mac?.pressureLevel, thermal = host?.thermal?.level;
  if (pressure && pressure !== 1 && !skip.includes('pressure')) chips.push({ text: `Pressure ${PRESSURE[pressure][0].toLowerCase()}`, tone: pressure === 4 ? 'bad' : 'warn' });
  if (thermal !== undefined && thermal >= THERMAL_WARN && !skip.includes('thermal')) chips.push({ text: `${THERMAL[thermal]![0]} heat`, tone: thermalLevel(thermal) === 'critical' ? 'bad' : 'warn' });
  const busy = snapshot && ['decode', 'prefill', 'processing'].includes(snapshot.runtime.phase);
  if ((options.gpu ?? true) && busy && host?.gpu?.busyFraction != null) chips.push({ text: `GPU ${pct(host.gpu.busyFraction)} busy` });
  return chips;
};
const chipOf = (id: string): string | null => id.startsWith('pressure') ? 'pressure' : id === 'thermal' ? 'thermal' : null;
/** Line 3: the most severe alert; "+N more" skips alerts already shown as chips. */
export const alertLine = (snapshot: SnapshotV2 | null): { severity: Severity; text: string; more: number; skip: string[] } | null => {
  const alerts = snapshot ? visibleAlerts(snapshot) : [];
  if (!alerts.length) return null;
  const [top, ...rest] = alerts, chipped = new Set(['pressure', 'thermal'].filter(kind => kind !== chipOf(top!.id)));
  return { severity: top!.severity, text: alertCopy(top!.id, top!.params)[0], more: rest.filter(alert => !chipped.has(chipOf(alert.id) ?? '')).length,
    skip: [chipOf(top!.id)].filter((kind): kind is string => kind !== null) };
};

const statusRow = (label: string, value: string, basis: string | null = null): StatusRow => ({ label, value, basis });
const basisOf = (basis: Basis): string | null => basis === 'reported' ? null : BASIS_WORD[basis];
const contextWindow = (snapshot: SnapshotV2 | null): number | null => snapshot?.runtime.request?.contextWindowTokens
  ?? snapshot?.runtime.residency.find(model => model.contextWindowTokens)?.contextWindowTokens ?? snapshot?.runtime.catalog.find(model => model.loaded)?.contextWindowTokens ?? null;
const usualRow = (usual: VsUsual | null): StatusRow[] => usual ? [statusRow('vs usual', `${delta(usual.ratio - 1)} · n ${usual.n}`, 'derived')] : [];

const blank = (line1: GlanceLine1, line2: GlanceLine2 | null, height: number, extra: Partial<StatusSectionView> = {}): StatusSectionView => ({
  mode: 'glance', height, rows: [],
  glance: { line1, line2, notice: null, alert: null }, turn: null, ...extra,
});
const L1 = (partial: Partial<GlanceLine1>): GlanceLine1 => ({ dot: 'idle', word: null, model: null, rate: null, rateBasis: 'reported', unit: null, chip: null, describedBy: false, title: null, since: null, muted: false, ...partial });

/** Turn stats rows (owner decision 13): Response, Turn time, Model · tool time, First TTFT, Tokens in · out, Cache %, Context used, vs usual. */
const turnRows = (input: StatusSectionInput): { rows: StatusRow[]; title: string; sub: string | null; reason: string | null; label: AttributionLabel } | null => {
  const { snapshot, turn, now } = input, request = snapshot?.runtime.request, window = input.window, basis = input.last?.completion.basis ?? 'reported';
  const tokens = basisOf(basis === 'last-observed' ? 'last-observed' : 'reported'), ctx = contextWindow(snapshot);
  const contextBasis = basisOf(basis === 'last-observed' ? 'last-observed' : 'derived');
  const running = window && window.startedAt !== null && window.endedAt === null && input.attribution.kind !== 'server-wide' && input.fresh !== false;
  if (running && snapshot && (request || ['decode', 'prefill', 'processing'].includes(snapshot.runtime.phase))) {
    const rows: StatusRow[] = [];
    if (request?.prefillFraction != null && snapshot.runtime.phase === 'prefill') rows.push(statusRow('Response now', `Reading ${pct(request.prefillFraction)}${request.prefillEtaMs != null ? ` · about ${dur(request.prefillEtaMs)} left` : ''}`, request.prefillEtaMs != null ? 'estimate' : null));
    else if (request?.decodeTps != null) rows.push(statusRow('Response now', `${tps(request.decodeTps)} tok/s`, basisOf(snapshot.capabilities['request.decodeRate']?.basis ?? 'reported')));
    if (request?.ttftMs != null && snapshot.capabilities['request.ttft']) rows.push(statusRow('First token', dur(request.ttftMs), basisOf(snapshot.capabilities['request.ttft'].basis)));
    rows.push(statusRow('Turn time', `${dur(now - window.startedAt!)} so far`, 'observed'));
    if (turn?.modelMs != null && turn.toolMs != null) rows.push(statusRow('Model · tool time', `${dur(turn.modelMs)} · ${dur(turn.toolMs)}`, 'observed'));
    if (request?.promptTokens != null && request.outputTokens != null) rows.push(statusRow('Tokens in · out', `${kt(request.promptTokens)} · ${int(request.outputTokens)}`));
    if (request?.promptTokens && request.cachedTokens != null) rows.push(statusRow('Cache %', pct(request.cachedTokens / request.promptTokens)));
    if (request?.contextUsedTokens != null && request.contextWindowTokens) rows.push(statusRow('Context used', `${kt(request.contextUsedTokens)} of ${kt(request.contextWindowTokens)}`, basisOf(snapshot.capabilities['request.context']?.basis ?? 'reported')));
    return { rows, title: 'This turn', sub: turn ? `step ${turn.steps + 1}` : null, reason: null, label: input.attribution };
  }
  const last = input.last;
  if (!last) return null;
  // A withheld turn uses only the last reply; all rows share the same rendering contract.
  const c = last.completion, summary = last.label.kind === 'server-wide' ? null : turn, rows: StatusRow[] = [];
  const rate = summary ? summary.decodeTps : c.decodeTps, first = summary ? summary.firstTtftMs : c.ttftMs;
  const prompt = summary ? summary.promptTokens : c.promptTokens, output = summary ? summary.outputTokens : c.outputTokens;
  const cache = summary ? summary.cacheFraction : c.promptTokens && c.cachedTokens != null ? c.cachedTokens / c.promptTokens : null;
  if (rate != null) rows.push(statusRow('Response', `${tps(rate)} tok/s`, summary && summary.steps > 1 ? 'derived' : basisOf(basis)));
  if (summary) {
    rows.push(statusRow('Turn time', dur(summary.wallMs), 'observed'));
    if (summary.modelMs != null && summary.toolMs != null) rows.push(statusRow('Model · tool time', `${dur(summary.modelMs)} · ${dur(summary.toolMs)}`, 'observed'));
  }
  if (first != null) rows.push(statusRow('First token', dur(first), basisOf(basis)));
  if (prompt != null && output != null) rows.push(statusRow('Tokens in · out', `${kt(prompt)} · ${int(output)}`, tokens));
  if (cache != null) rows.push(statusRow('Cache %', pct(cache), tokens));
  const used = (c.promptTokens ?? 0) + (c.outputTokens ?? 0);
  if (used && ctx && c.model === modelOf(snapshot!)) rows.push(statusRow('Context used', `${kt(used)} of ${kt(ctx)}`, contextBasis));
  const reason = last.label.kind === 'server-wide' ? `${withheldWhy(last.label.reason)} · no turn summary` : null;
  return { rows: [...rows, ...usualRow(input.vsUsual)], title: summary ? 'Last turn' : 'Last reply',
    sub: summary ? `${summary.steps} ${summary.steps === 1 ? 'step' : 'steps'}` : ago(c.finishedAt, now), reason, label: last.label };
};

export const presentStatusSection = (input: StatusSectionInput): StatusSectionView => {
  const { snapshot, now, reading } = input, reason = reading.reason;
  if (reason === 'needs_approval') return blank(L1({ title: APPROVAL.title }), { kind: 'note', text: APPROVAL.glance }, HEIGHTS.glance);
  if (reason === 'contract_mismatch') return blank(L1({ title: RESTART.title }), { kind: 'note', text: RESTART.glance }, HEIGHTS.glance);
  if (input.chatIsLocal === false) return { ...blank(L1({ title: NON_LOCAL, muted: true }), null, HEIGHTS.nonLocal), mode: 'non-local' };
  if (!snapshot) return blank(L1({ dot: reading.reason ? 'warn' : 'idle', title: reading.reason ? 'MLX Scope can’t read its service' : 'Connecting to the local runtime' }),
    reading.message ? { kind: 'note', text: reading.message } : null, HEIGHTS.glance);
  if (input.paused) return blank(L1({ word: 'Paused', model: glanceOr(snapshot) }), { kind: 'note', text: 'Only this monitor is paused; your model keeps running' }, HEIGHTS.glance);
  const status = statusCopy(snapshot);
  if (status && snapshot.status.reason !== 'admin_unauthorized') {
    const dot: DotTone = status.severity === 'critical' ? 'bad' : status.severity === 'warning' ? 'warn' : 'idle';
    return blank(L1({ dot, title: status.title, since: sinceText(status.since, now) || null }), { kind: 'note', text: statusGlanceNote(snapshot) }, HEIGHTS.glance);
  }
  if (input.fresh === false) return blank(L1({ dot: 'warn', title: 'No fresh readings' }), { kind: 'note', text: 'Retained readings are not live' }, HEIGHTS.glance);

  const alert = alertLine(snapshot), spark = sparkline(input.sparkline), request = snapshot.runtime.request, phase = snapshot.runtime.phase;
  // Turn stats replacement, when chosen and there is a turn or a reply to show.
  if (input.expanded) {
    const turn = turnRows(input);
    if (turn) {
      const chip = attrChip(turn.label, turn.label.kind === 'server-wide');
      return { mode: 'turn-stats', height: Math.min(200, turnHeight(turn.rows.length, turn.reason !== null) + (alert ? 8 : 0)), rows: turn.rows, glance: null,
        turn: { alert, dot: turn.title === 'This turn' ? 'live' : 'idle', title: turn.title, sub: turn.sub, chip, reason: turn.reason, spark,
          chips: glanceChips(snapshot, { gpu: turn.title === 'This turn', skip: alert?.skip }) } };
    }
  }
  const model = glanceOr(snapshot), next = input.next, last = input.last, chips = glanceChips(snapshot, { gpu: false, skip: alert?.skip });
  const notice: GlanceNotice | null = !input.tipDismissed ? { text: TIP, action: null, dismiss: 'tip' }
    : input.firstRun && !input.firstRunDismissed ? { text: FIRST_RUN, action: 'Open Scope to manage', dismiss: 'first-run' } : null;
  /** One glance: a server-wide chip is short and names its reason on line 2, which then stays even beside a notice. */
  const glance = (line1: GlanceLine1, line2: GlanceLine2 | null, reasonOnLine2 = false): StatusSectionView => {
    const metrics: StatusRow[] = [];
    const active = ['decode', 'prefill', 'processing'].includes(phase);
    if (active && request?.ttftMs != null && snapshot.capabilities['request.ttft']) {
      metrics.push(statusRow('First token', dur(request.ttftMs), basisOf(snapshot.capabilities['request.ttft'].basis)));
    } else if (line1.word === 'Last reply' && last?.completion.ttftMs != null && last.completion.basis !== 'last-observed') {
      metrics.push(statusRow('First token', dur(last.completion.ttftMs), basisOf(last.completion.basis)));
    }
    if (active && request?.contextUsedTokens != null && request.contextWindowTokens) {
      metrics.push(statusRow('Context used', `${kt(request.contextUsedTokens)} of ${kt(request.contextWindowTokens)}`, basisOf(snapshot.capabilities['request.context']?.basis ?? 'reported')));
    }
    // Optional onboarding yields to the measurements and warnings; it can reappear when there is room.
    const fullHeight = glanceHeight(line2 !== null, notice, alert !== null) + (line1.model ? 24 : 0)
      + (alert ? 8 : 0) + (line1.since && line1.model ? 16 : 0) + metrics.length * 20;
    const shownNotice = fullHeight <= HEIGHTS.max ? notice : null;
    const keep = line2 && (!shownNotice || reasonOnLine2) ? line2 : null;
    return { ...blank(line1, keep, glanceHeight(keep !== null, shownNotice, alert !== null)),
      glance: { line1, line2: keep, metrics, notice: shownNotice, alert: alert && { severity: alert.severity, text: alert.text, more: alert.more } } };
  };
  const described = (label: AttributionLabel, line: Partial<GlanceLine1>, rest: Omit<Extract<GlanceLine2, { kind: 'spark' }>, 'kind' | 'reason'>): StatusSectionView => {
    const reason = label.kind === 'server-wide' ? withheldWhy(label.reason) : null;
    return glance(L1({ ...line, chip: attrChip(label, reason !== null), describedBy: reason !== null }), { kind: 'spark', ...rest, reason }, reason !== null);
  };
  if (phase === 'prefill' && request?.prefillFraction != null) {
    const label = input.attribution;
    if (label.kind === 'server-wide') return described(label, { dot: 'prefill', model }, { spark: null, size: 'sm', last: null, chips, toggle: true });
    return glance(L1({ dot: 'prefill', model, chip: attrChip(label) }),
      { kind: 'prefill', percent: pct(request.prefillFraction), eta: request.prefillEtaMs != null && !request.prefillStale ? dur(request.prefillEtaMs) : null, toggle: true });
  }
  if (request?.decodeTps != null) {
    const line = { dot: 'live' as const, model, rate: tps(request.decodeTps), rateBasis: snapshot.capabilities['request.decodeRate']?.basis ?? 'reported', unit: 'tok/s' };
    if (next?.kind === 'measuring') return glance(L1({ ...line, chip: attrChip({ kind: 'armed' }) }), { kind: 'measuring', elapsed: dur(Math.max(0, now - next.startedAt)) });
    return described(input.attribution, line, { spark, size: input.attribution.kind === 'server-wide' ? 'sm' : '', last: null, chips, toggle: true });
  }
  const serverRate = liveSplashRate(snapshot);
  if (serverRate !== null) return described({ kind: 'server-wide', reason: 'all-requests' },
    { dot: 'live', word: 'Live', model, rate: tps(serverRate), rateBasis: 'derived', unit: 'tok/s' },
    { spark: null, size: 'sm', last: null, chips, toggle: true });
  // Idle, queued or inventory: the last reply keeps its label; an armed Next reply waits for a message.
  const word = phase === 'queued' ? 'Queued' : phase === 'not-loaded' ? 'No model' : ['decode', 'prefill', 'processing'].includes(phase) ? 'Working' : 'Idle';
  if (next?.kind === 'armed') return glance(L1({ word, model, chip: attrChip({ kind: 'armed' }) }), { kind: 'armed', left: mmss(Math.max(0, 120_000 - (now - next.at))) });
  if (phase === 'idle' && last?.completion.decodeTps != null) return described(last.label,
    { word: 'Last reply', model: last.completion.model ? glanceModel(last.completion.model) : model,
      rate: tps(last.completion.decodeTps), rateBasis: last.completion.basis, unit: 'tok/s', since: ago(last.completion.finishedAt, now) },
    { spark, size: 'sm', last: null, chips, toggle: true });
  if (last && last.label.kind === 'server-wide') return described(last.label, { word, model }, { spark, size: 'sm', last: null, chips, toggle: true });
  return glance(L1({ word, model, chip: last ? attrChip(last.label) : null }), { kind: 'spark', spark, size: 'sm', reason: null, chips, toggle: true,
    last: last?.completion.decodeTps != null ? { rate: tps(last.completion.decodeTps), basis: basisOf(last.completion.basis) } : null });
};
const glanceOr = (snapshot: SnapshotV2): string | null => { const model = modelOf(snapshot); return model ? glanceModel(model) : null; };
export { SERVER_WIDE, SEVERITY_WORD };
