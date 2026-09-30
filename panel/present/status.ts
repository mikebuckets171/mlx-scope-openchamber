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
import { delta, dur, int, kt, mmss, pct, tps } from './format.ts';
import { attrChip, BASIS_WORD, visibleAlerts, type Chip } from './parts.ts';
import type { Reading } from './reading.ts';
import { glanceModel, modelOf, SERVER_WIDE } from './scope.ts';

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
export interface GlanceLine1 { dot: DotTone; word: string | null; model: string | null; rate: string | null; unit: string | null; chip: Chip | null; describedBy: boolean; title: string | null; since: string | null; muted: boolean }
export type GlanceLine2 =
  | { kind: 'spark'; spark: Spark | null; size: '' | 'sm' | 'wide'; reason: string | null; last: { rate: string; basis: string | null } | null; chips: Chip[]; toggle: boolean }
  | { kind: 'prefill'; percent: string; eta: string | null; toggle: boolean }
  | { kind: 'note'; text: string }
  | { kind: 'armed'; left: string }
  | { kind: 'measuring'; elapsed: string }
  | { kind: 'notice'; text: string; action: string | null; dismiss: 'tip' | 'first-run'; severity: 'info' };
export interface StatusSectionView {
  mode: StatusMode;
  height: number;                            // setHeight: 24 | 56 | 80 | ≤ 200
  line1: { phase: string; model: string | null; rate: string | null; attribution: string };
  line2: { chips: string[]; alert: string | null } | null;
  rows: StatusRow[];                         // turn-stats mode only
  tip: string | null;
  // Additions (ui-core): the structure the markup draws.
  glance: { line1: GlanceLine1; line2: GlanceLine2 | null; alert: { severity: Severity; text: string; more: number } | null } | null;
  turn: { dot: DotTone; title: string; sub: string | null; chip: Chip; reason: string | null; spark: Spark | null; chips: Chip[] } | null;
}

/** The status frame's heights (G2): padding 4 + 24 px lines; Turn stats rows are 16 px. */
export const HEIGHTS = { nonLocal: 24, glance: 56, alert: 80, firstRun: 80, tip: 96, max: 200 } as const;
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

const labelText = (label: AttributionLabel): string => label.kind === 'inferred' ? 'This chat · inferred' : label.kind === 'armed' ? 'Next reply · armed' : `Server-wide · ${withheldWhy(label.reason)}`;
const basisOf = (basis: Basis): string | null => basis === 'reported' ? null : BASIS_WORD[basis];
const contextWindow = (snapshot: SnapshotV2 | null): number | null => snapshot?.runtime.request?.contextWindowTokens
  ?? snapshot?.runtime.residency.find(model => model.contextWindowTokens)?.contextWindowTokens ?? snapshot?.runtime.catalog.find(model => model.loaded)?.contextWindowTokens ?? null;
const usualRow = (usual: VsUsual | null): StatusRow[] => usual ? [{ label: 'vs usual', value: `${delta(usual.ratio - 1)} · n ${usual.n}`, basis: 'derived' }] : [];

const blank = (line1: GlanceLine1, line2: GlanceLine2 | null, height: number, extra: Partial<StatusSectionView> = {}): StatusSectionView => ({
  mode: 'glance', height, line1: { phase: line1.word ?? line1.title ?? '', model: line1.model, rate: line1.rate, attribution: line1.chip?.text ?? '' },
  line2: line2 && line2.kind === 'spark' ? { chips: line2.chips.map(chip => chip.text), alert: null } : null, rows: [], tip: null,
  glance: { line1, line2, alert: null }, turn: null, ...extra,
});
const L1 = (partial: Partial<GlanceLine1>): GlanceLine1 => ({ dot: 'idle', word: null, model: null, rate: null, unit: null, chip: null, describedBy: false, title: null, since: null, muted: false, ...partial });

/** Turn stats rows (owner decision 13): Response, Turn time, Model · tool time, First TTFT, Tokens in · out, Cache %, Context used, vs usual. */
const turnRows = (input: StatusSectionInput): { rows: StatusRow[]; title: string; sub: string | null; reason: string | null; label: AttributionLabel } | null => {
  const { snapshot, turn, now } = input, request = snapshot?.runtime.request, window = input.window, basis = input.last?.completion.basis ?? 'reported';
  const tokens = basisOf(basis === 'last-observed' ? 'last-observed' : 'reported'), ctx = contextWindow(snapshot);
  const running = window && window.startedAt !== null && window.endedAt === null && input.attribution.kind !== 'server-wide' && input.fresh !== false;
  if (running && snapshot && (request || ['decode', 'prefill', 'processing'].includes(snapshot.runtime.phase))) {
    const rows: StatusRow[] = [];
    if (request?.prefillFraction != null && snapshot.runtime.phase === 'prefill') rows.push({ label: 'Response now', value: `Reading ${pct(request.prefillFraction)}${request.prefillEtaMs != null ? ` · about ${dur(request.prefillEtaMs)} left` : ''}`, basis: request.prefillEtaMs != null ? 'estimate' : null });
    else if (request?.decodeTps != null) rows.push({ label: 'Response now', value: `${tps(request.decodeTps)} tok/s`, basis: null });
    rows.push({ label: 'Turn time', value: `${dur(now - window.startedAt!)} so far`, basis: 'observed' });
    if (turn?.modelMs != null && turn.toolMs != null) rows.push({ label: 'Model · tool time', value: `${dur(turn.modelMs)} · ${dur(turn.toolMs)}`, basis: 'observed' });
    if (request?.promptTokens != null && request.outputTokens != null) rows.push({ label: 'Tokens in · out', value: `${kt(request.promptTokens)} · ${int(request.outputTokens)}`, basis: null });
    if (request?.promptTokens && request.cachedTokens != null) rows.push({ label: 'Cache %', value: pct(request.cachedTokens / request.promptTokens), basis: null });
    if (request?.contextUsedTokens && request.contextWindowTokens) rows.push({ label: 'Context used', value: `${kt(request.contextUsedTokens)} of ${kt(request.contextWindowTokens)}`, basis: null });
    return { rows, title: 'This turn', sub: turn ? `step ${turn.steps + 1}` : null, reason: null, label: input.attribution };
  }
  if (turn && input.last && input.last.label.kind !== 'server-wide') {
    const rows: StatusRow[] = [];
    if (turn.decodeTps != null) rows.push({ label: 'Response', value: `${tps(turn.decodeTps)} tok/s`, basis: turn.steps > 1 ? 'derived' : basisOf(basis) });
    rows.push({ label: 'Turn time', value: dur(turn.wallMs), basis: 'observed' });
    if (turn.modelMs != null && turn.toolMs != null) rows.push({ label: 'Model · tool time', value: `${dur(turn.modelMs)} · ${dur(turn.toolMs)}`, basis: 'observed' });
    if (turn.firstTtftMs != null) rows.push({ label: 'First TTFT', value: dur(turn.firstTtftMs), basis: basisOf(basis) });
    if (turn.promptTokens != null) rows.push({ label: 'Tokens in · out', value: `${kt(turn.promptTokens)} · ${int(turn.outputTokens)}`, basis: tokens });
    if (turn.cacheFraction != null) rows.push({ label: 'Cache %', value: pct(turn.cacheFraction), basis: tokens });
    const used = (input.last.completion.promptTokens ?? 0) + (input.last.completion.outputTokens ?? 0);
    if (used && ctx) rows.push({ label: 'Context used', value: `${kt(used)} of ${kt(ctx)}`, basis: tokens });
    return { rows: [...rows, ...usualRow(input.vsUsual)], title: 'Last turn', sub: `${turn.steps} ${turn.steps === 1 ? 'step' : 'steps'}`, reason: null, label: input.last.label };
  }
  const last = input.last;
  if (!last) return null;
  // A withheld turn: no summary; the slot shows the last reply, server-wide, with its reason.
  const c = last.completion, rows: StatusRow[] = [];
  if (c.decodeTps != null) rows.push({ label: 'Response', value: `${tps(c.decodeTps)} tok/s`, basis: basisOf(c.basis) });
  if (c.ttftMs != null) rows.push({ label: 'TTFT', value: dur(c.ttftMs), basis: basisOf(c.basis) });
  if (c.promptTokens != null && c.outputTokens != null) rows.push({ label: 'Tokens in · out', value: `${kt(c.promptTokens)} · ${int(c.outputTokens)}`, basis: tokens });
  if (c.promptTokens && c.cachedTokens != null) rows.push({ label: 'Cache %', value: pct(c.cachedTokens / c.promptTokens), basis: tokens });
  const used = (c.promptTokens ?? 0) + (c.outputTokens ?? 0);
  if (used && ctx) rows.push({ label: 'Context used', value: `${kt(used)} of ${kt(ctx)}`, basis: tokens });
  const reason = last.label.kind === 'server-wide' ? `${withheldWhy(last.label.reason)} · no turn summary` : null;
  return { rows: [...rows, ...usualRow(input.vsUsual)], title: 'Last reply', sub: null, reason, label: last.label };
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
  const withAlert = (view: StatusSectionView): StatusSectionView => !alert || !view.glance ? view
    : { ...view, height: view.height + 24, line2: view.line2 && { ...view.line2, alert: alert.text }, glance: { ...view.glance, alert } };
  // Turn stats replacement, when chosen and there is a turn or a reply to show.
  if (input.expanded) {
    const turn = turnRows(input);
    if (turn) {
      const chip = attrChip(turn.label, turn.label.kind === 'server-wide');
      return { mode: 'turn-stats', height: turnHeight(turn.rows.length, turn.reason !== null), rows: turn.rows, tip: null,
        line1: { phase: turn.title, model: null, rate: null, attribution: labelText(turn.label) }, line2: null, glance: null,
        turn: { dot: turn.title === 'This turn' ? 'live' : 'idle', title: turn.title, sub: turn.sub, chip, reason: turn.reason, spark,
          chips: glanceChips(snapshot, { gpu: turn.title === 'This turn', skip: alert?.skip }) } };
    }
  }
  const model = glanceOr(snapshot), label = input.attribution, next = input.next;
  const serverWide = label.kind === 'server-wide';
  const notice = (): GlanceLine2 | null => !input.tipDismissed ? { kind: 'notice', text: TIP, action: null, dismiss: 'tip', severity: 'info' }
    : input.firstRun && !input.firstRunDismissed ? { kind: 'notice', text: FIRST_RUN, action: 'Open Scope to manage', dismiss: 'first-run', severity: 'info' } : null;
  const noticeHeight = (line: GlanceLine2): number => line.kind === 'notice' && line.dismiss === 'tip' ? HEIGHTS.tip : HEIGHTS.firstRun;
  if (phase === 'prefill' && request?.prefillFraction != null) {
    const line1 = L1({ dot: 'prefill', model, chip: attrChip(label), describedBy: false });
    const shown = notice();
    if (shown) return blank(line1, shown, noticeHeight(shown));
    return withAlert(blank(line1, { kind: 'prefill', percent: pct(request.prefillFraction), eta: request.prefillEtaMs != null && !request.prefillStale ? dur(request.prefillEtaMs) : null, toggle: true }, HEIGHTS.glance));
  }
  if (request?.decodeTps != null) {
    const armedRun = next?.kind === 'measuring', shown = notice();
    // A short "Server-wide" chip points at its reason on line 2; with a notice in that line, the chip says it itself.
    const short = serverWide && !armedRun && !shown;
    const chip = armedRun ? attrChip({ kind: 'armed' }) : attrChip(label, short);
    const line1 = L1({ dot: 'live', model, rate: tps(request.decodeTps), unit: 'tok/s', chip, describedBy: short });
    if (shown) return blank(line1, shown, noticeHeight(shown));
    if (armedRun) return withAlert(blank(line1, { kind: 'measuring', elapsed: dur(Math.max(0, now - next.startedAt)) }, HEIGHTS.glance));
    return withAlert(blank(line1, { kind: 'spark', spark, size: serverWide ? 'sm' : '', reason: serverWide && label.kind === 'server-wide' ? withheldWhy(label.reason) : null,
      last: null, chips: glanceChips(snapshot, { skip: alert?.skip }), toggle: true }, HEIGHTS.glance));
  }
  // Idle, queued or inventory: the last reply keeps its label; an armed Next reply waits for a message.
  const last = input.last, word = phase === 'queued' ? 'Queued' : phase === 'not-loaded' ? 'No model' : ['decode', 'prefill', 'processing'].includes(phase) ? 'Working' : 'Idle';
  if (next?.kind === 'armed') return withAlert(blank(L1({ word, model, chip: attrChip({ kind: 'armed' }) }), { kind: 'armed', left: mmss(Math.max(0, 120_000 - (now - next.at))) }, HEIGHTS.glance));
  const line1 = L1({ word, model, chip: last ? attrChip(last.label) : null });
  const shown = notice();
  if (shown) return blank(line1, shown, noticeHeight(shown));
  return withAlert(blank(line1, { kind: 'spark', spark, size: 'sm', reason: null, chips: glanceChips(snapshot, { skip: alert?.skip }), toggle: true,
    last: last?.completion.decodeTps != null ? { rate: tps(last.completion.decodeTps), basis: basisOf(last.completion.basis) } : null }, HEIGHTS.glance));
};
const glanceOr = (snapshot: SnapshotV2): string | null => { const model = modelOf(snapshot); return model ? glanceModel(model) : null; };
export { SERVER_WIDE, SEVERITY_WORD };
