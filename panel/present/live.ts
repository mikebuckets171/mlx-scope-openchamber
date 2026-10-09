import { presentSpeeds, type SpeedsView } from './speeds.ts';
import type { Basis } from '../../src/contract/capabilities.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import type { AttributionLabel } from '../attribution/join.ts';
import { liveChart, type ChartView } from '../render/chart.ts';
import { connName, PRESSURE, RT, rtName, statusCopy, THERMAL, THERMAL_WARN, thermalLevel, type Level } from './copy.ts';
import { ago, delta, dur, int, kt, mmss, pct, size, tps } from './format.ts';
import { attrChip, attrTip, callouts, splashRateTip, tip, weightedTps, type Callout, type Chip, type Tip, type Val } from './parts.ts';
export { weightedTps } from './parts.ts';
import { ENGINE_SPEED, heldBySource, liveSplashRate, modelOf, SERVER_WIDE, SPLASH_WAITING, type ScopeInput } from './scope.ts';
import { promptPercent } from '../progress.ts';
import { presentSessionSection, type SessionSectionView } from './session.ts';
import { fromSnapshot } from './reading.ts';

// The Live tab (plan §5.9, the G2 mock): callouts, the hero (one speed with its basis ⓘ, the attribution chip, Last
// reply and Next reply), the request tiles and the This Mac card with the short labels (full wording in its ⓘ).

export type HeroKind = 'prefill' | 'decode' | 'server-decode' | 'busy' | 'slots' | 'ollama' | 'server' | 'queued' | 'processing' | 'inventory' | 'idle';
export type HeroBody =
  | { kind: 'paused'; note: string }
  | { kind: 'prefill'; percent: string; fraction: number; counts: string | null; eta: string | null; rate: string | null; source: string; tip: Tip }
  | { kind: 'decode'; rate: string; basis: Basis; label: string; source: string; tip: Tip; chart: ChartView | null }
  | { kind: 'word'; word: string; unit: string; note: Val | null };
export type NextView =
  | { kind: 'offer' } | { kind: 'watch'; runtime: string } | { kind: 'armed'; left: string; tip: Tip }
  | { kind: 'measuring'; elapsed: string } | { kind: 'result' };
export interface ReplyView {
  chip: Chip | null; tip: Tip | null; when: string | null; empty: string | null;
  values: Val[]; split: Val[]; usual: Chip | null; next: NextView | null; model?: string;
}
export interface HeroView { instrument: SessionSectionView; speeds: SpeedsView; title: string; chatOnly?: boolean; attr: { chip: Chip; tip: Tip } | null; body: HeroBody | null; engineTrend: { chart: ChartView | null } | null; firstToken: Val | null; context: { used: string; basis: Basis; fraction: number; tip: Tip } | null; reply: ReplyView | null }
export interface Tile { label: string; value: string; detail: string; meter: number | null }
export interface MacRow { key: string; label: string; value: Val; level: Level | null; meter: number | null; tip: Tip | null }
export interface MacView { title: string; tip: Tip; stale: boolean; line: Array<{ label: string; value: string; meter: number | null }>; rows: MacRow[]; details: MacRow[] }
export interface LiveView { callouts: Callout[]; hero: HeroView | null; tiles: Tile[]; mac: MacView | null }

const LABELLED = new Set<HeroKind>(['decode', 'server-decode', 'prefill', 'busy', 'slots', 'ollama', 'server']);
const ACTIVE = new Set(['decode', 'prefill', 'processing']);

/** Which reading the hero shows. A status message owns the view instead, except oMLX's public-status fallback. */
export const heroKind = (s: ScopeInput): HeroKind | null => {
  const snapshot = s.snapshot, runtime = snapshot?.runtime;
  if (!snapshot || !runtime || s.paused || !s.fresh || statusCopy(snapshot) && snapshot.status.reason !== 'admin_unauthorized' || runtime.phase === 'not-loaded') return null;
  const request = runtime.request, active = runtime.server.active;
  if (runtime.phase === 'prefill' && request?.prefillFraction != null) return 'prefill';
  if (request?.decodeTps != null) return 'decode';
  if (liveSplashRate(snapshot) !== null) return 'server-decode';
  if (runtime.slots.length && (active ?? 0) > 1) return 'slots';
  if (runtime.residency.some(model => model.source === 'ollama-ps')) return 'ollama';
  if (snapshot.status.reason === 'admin_unauthorized') return 'server';
  if (ACTIVE.has(runtime.phase) && (active ?? 0) > 1) return 'busy';
  if (runtime.phase === 'queued') return 'queued';
  if (ACTIVE.has(runtime.phase)) return 'processing';
  if (!snapshot.capabilities['server.requests']) return 'inventory';
  return 'idle';
};
/** Readings server-wide by nature carry their reason; the rest take the attribution module's label. */
const liveLabel = (kind: HeroKind, s: ScopeInput): AttributionLabel =>
  kind === 'slots' || kind === 'busy' ? { kind: 'server-wide', reason: 'overlap' } : kind === 'ollama' ? { kind: 'server-wide', reason: 'cannot-count' }
    : kind === 'server' || kind === 'server-decode' ? { kind: 'server-wide', reason: 'all-requests' } : s.attribution;

const heroBody = (kind: HeroKind, s: ScopeInput): HeroBody => {
  const snapshot = s.snapshot!, runtime = snapshot.runtime, request = runtime.request, rt = rtName(snapshot.connection);
  const server = runtime.server, active = server.active ?? 0, queued = server.queued ?? 0;
  const word = (text: string, unit: string, note: Val | null = null): HeroBody => ({ kind: 'word', word: text, unit, note });
  switch (kind) {
    case 'prefill': {
      const fraction = request!.prefillFraction!, stale = request!.prefillStale === true;
      const done = request!.prefillProcessedTokens, total = request!.prefillTotalTokens;
      return { kind: 'prefill', percent: `${promptPercent(fraction)}${stale ? ' (last seen)' : ''}`, fraction, counts: done != null && total != null ? `${int(done)} of ${int(total)} ${snapshot.connection.runtime === 'splash' ? 'prompt tokens processed' : 'new tokens read'}` : null,
        eta: !stale && request!.prefillEtaMs != null ? dur(request!.prefillEtaMs) : null, rate: request!.prefillTps != null ? tps(request!.prefillTps) : null,
        source: `From ${rt}`, tip: tip('basis', `From ${rt}`, [`${rt} reports how much of this prompt has been read.`,
          request!.prefillEtaMs != null && `${rt} estimates the finish time; it changes during prefill.`, stale && 'Progress has not updated yet.']) };
    }
    case 'decode': {
      const basis = snapshot.capabilities['request.decodeRate']?.basis ?? 'reported';
      const source = basis === 'reported' ? `From ${rt}` : `${basis === 'observed' ? 'Measured' : basis === 'derived' ? 'Calculated' : basis === 'estimate' ? 'Estimated' : 'Last reading'} from ${rt}`;
      return { kind: 'decode', rate: tps(request!.decodeTps!), basis, label: basis === 'observed' ? 'Measured generation speed' : 'Average for this request', source,
        tip: tip('basis', source, [basis === 'reported' ? `${rt} reports this request’s average speed, without Scope smoothing or estimates.` : 'Calculated from server readings. This is an average for the request.']),
        chart: liveChart(s.samples, s.now, s.turnStartAt) };
    }
    case 'server-decode': return { kind: 'decode', rate: tps(liveSplashRate(snapshot)!), basis: 'derived', label: ENGINE_SPEED, source: `Calculated from ${rt} · last ${dur(server.rates!.windowMs)}`,
      tip: splashRateTip('basis', server.rates!.windowMs),
      chart: liveChart(s.samples, s.now, null, 'server') };
    case 'slots': case 'busy': {
      if (snapshot.connection.runtime === 'splash') return word('Working', SPLASH_WAITING);
      const rates = server.rates;
      return word(`${active} requests`, `Speed unavailable for one request: ${active} ${kind === 'slots' ? 'slots are busy' : 'requests are running'}`,
        rates?.decodeTps != null ? { text: `Generation `, strong: `${tps(rates.decodeTps)} tok/s`, unit: `over the last ${Math.round(rates.windowMs / 1_000)} s`,
          basis: 'derived', note: `Calculated from ${rt}` } : null);
    }
    case 'ollama': return word(`${runtime.residency.length} loaded`, 'Ollama lists loaded models but does not provide request speeds');
    case 'server': return word(`${active} running`, queued ? `${queued} waiting` : 'Nothing waiting');
    case 'queued': return word(`${queued} waiting`, `${active} running`);
    case 'processing': return word('Working', snapshot.connection.runtime === 'splash' ? runtime.phase === 'prefill' ? 'Reading prompt · waiting for update' : SPLASH_WAITING : `${rt} doesn’t report this request’s speed`);
    case 'inventory': return word('Connected', `${rt} lists its models · no live request readings`);
    default: return word('Idle', 'Model loaded · ready for the next request');
  }
};

const contextBlock = (s: ScopeInput): HeroView['context'] => {
  const request = s.snapshot?.runtime.request;
  if (!s.snapshot || !ACTIVE.has(s.snapshot.runtime.phase) || !request?.contextWindowTokens || request.contextUsedTokens == null) return null;
  return { used: `${kt(request.contextUsedTokens)} of ${kt(request.contextWindowTokens)} tokens`, basis: s.snapshot.capabilities['request.context']?.basis ?? 'reported', fraction: Math.min(1, request.contextUsedTokens / request.contextWindowTokens),
    tip: tip('ctx', 'Context used', ['Prompt and output tokens compared with the model’s context limit.', 'OpenCode may shorten the chat before this limit.']) };
};

const nextView = (s: ScopeInput): NextView | null => {
  const snapshot = s.snapshot!, next = s.next;
  if (s.paused || statusCopy(snapshot) || !snapshot.capabilities['server.completions'] || snapshot.runtime.phase === 'not-loaded') return null;
  switch (next.kind) {
    case 'offer-watch': return { kind: 'watch', runtime: next.runtime };
    case 'armed': return { kind: 'armed', left: mmss(Math.max(0, 120_000 - (s.now - next.at))),
      tip: tip('armed', 'Next reply', ['Waiting for your next message in this chat. Measures one reply, then stops.', 'Cancels if you switch chats, the server stops responding, or Scope closes or becomes hidden.']) };
    case 'measuring': return { kind: 'measuring', elapsed: dur(Math.max(0, s.now - next.startedAt)) };
    case 'result': return { kind: 'result' };
    default: return { kind: 'offer' };
  }
};
const usualChip = (s: ScopeInput): Chip | null => {
  const flag = s.last?.flag, usual = s.last?.vsUsual;
  if (flag) return { text: `Slower · ${delta(flag.recentMedian / flag.p50 - 1)} · last 3`, tone: 'warn', basis: 'derived' };
  return usual ? { text: `${delta(usual.ratio - 1)} vs usual`, basis: 'derived' } : null;
};
const replyView = (s: ScopeInput): ReplyView | null => {
  const snapshot = s.snapshot!, rt = rtName(snapshot.connection), next = s.next;
  if (!snapshot.capabilities['server.completions'] || s.paused) return null;
  const nextRow = nextView(s);
  if (next.kind === 'result') {
    const steps = next.steps, rate = weightedTps(steps), output = steps.reduce((sum, step) => sum + (step.outputTokens ?? 0), 0);
    const model = steps.reduce((sum, step) => sum + (step.startedAt === null ? 0 : step.finishedAt - step.startedAt), 0), whole = next.endedAt - next.startedAt;
    const label: AttributionLabel = next.attributed ? { kind: 'armed' }
      : { kind: 'server-wide', reason: steps.find(step => step.verdict?.attr === 'withheld')?.verdict?.reason ?? 'not-observed' };
    return { chip: attrChip(label), when: ago(next.endedAt, s.now), empty: null, usual: null, next: nextRow,
      tip: next.attributed
        ? tip('reply', 'Last reply · Next reply', ['Measured at your request. Turn times come from OpenChamber; speed comes from server readings for each step.'])
        : tip('reply', 'Last reply · All server activity', ['A step couldn’t be tied to this chat: no turn summary.', ...attrTip('reply', label, snapshot, false, s.chatRuntime).paras]),
      values: [...rate !== null ? [{ text: '', strong: tps(rate), unit: 'tok/s', basis: steps.length > 1 ? 'derived' : steps[0]!.basis } satisfies Val] : [],
        { text: '', strong: int(output), unit: 'out', basis: 'reported' },
        ...steps[0]?.ttftMs != null && steps[0].basis !== 'last-observed' ? [{ text: 'First token', strong: dur(steps[0].ttftMs), basis: steps[0].basis } satisfies Val] : []],
      split: next.attributed ? [{ text: 'Turn', strong: dur(whole), basis: 'observed' }, ...model > 0 ? [{ text: 'Model · tool', strong: `${dur(model)} · ${dur(Math.max(0, whole - model))}`, basis: 'observed' } satisfies Val] : []] : [] };
  }
  const last = s.last;
  if (!last) return { chip: null, tip: null, when: null, empty: 'No replies yet · replies appear while Scope is open', values: [], split: [], usual: null, next: nextRow };
  const c = last.completion, flag = last.flag, usual = last.vsUsual;
  return {
    chip: attrChip(last.label), model: c.model ?? undefined, when: ago(c.finishedAt, s.now), empty: null, next: nextRow, split: [], usual: usualChip(s),
    tip: tip('reply', 'Last reply', [
      flag ? `Middle speed of the last 3 replies: ${tps(flag.recentMedian)} tok/s. Usual middle speed: ${tps(flag.p50)}, from ${flag.n} replies.`
        : usual ? `${delta(usual.ratio - 1)} against the usual speed for this model and context size, from ${usual.n} replies.` : null,
      c.basis === 'last-observed' && `${rt} does not provide finished replies or first-token timing; this is Scope’s last request reading.`,
      !!c.aggregateOf && `${c.aggregateOf} requests were measured together; this is their average.`,
      last.label.kind === 'server-wide' && attrTip('x', last.label, snapshot, false, s.chatRuntime).paras.join(' ')]),
    values: [...c.decodeTps != null ? [{ text: '', strong: tps(c.decodeTps), unit: 'tok/s', basis: c.basis } satisfies Val] : [],
      ...c.outputTokens != null ? [{ text: '', strong: int(c.outputTokens), unit: 'out', basis: 'reported' } satisfies Val] : [],
      ...c.ttftMs != null ? [{ text: 'First token', strong: dur(c.ttftMs), basis: c.basis === 'reported' ? 'reported' : c.basis } satisfies Val] : []],
  };
};

const presentHero = (s: ScopeInput): HeroView | null => {
  const snapshot = s.snapshot;
  if (!snapshot) return null;
  const instrument = presentSessionSection({ ...s, reading: fromSnapshot(snapshot), chatIsLocal: s.chatIsLocal ?? null,
    turn: null, vsUsual: s.last?.vsUsual ?? null, sparkline: null, expanded: false, tipDismissed: true });
  if (s.measurementScope !== 'engine' && s.chatIsLocal === false) return { instrument, speeds: instrument.speeds, title: 'This chat', chatOnly: true,
    attr: null, body: null, engineTrend: null, firstToken: null, context: null, reply: null };
  const kind = heroKind(s), title = modelOf(snapshot) ?? connName(snapshot.connection), body = kind ? heroBody(kind, s) : null;
  // Keep the disclosure in place across lifecycle changes. Only compatible engine readings enter its chart.
  const engineTrend = snapshot.capabilities['request.decodeRate'] || snapshot.capabilities['server.rates']
    ? { chart: body?.kind === 'decode' ? body.chart : liveChart(s.samples, s.now, snapshot.connection.runtime === 'splash' ? null : s.turnStartAt,
      snapshot.connection.runtime === 'splash' ? 'server' : 'request') } : null;
  if (s.paused) return { instrument, speeds: presentSpeeds(s), title, attr: null, body: { kind: 'paused', note: 'Nothing is read while paused, so no reply is recorded.' }, engineTrend, firstToken: null, context: null, reply: null };
  const reply = replyView(s);

  const live = kind === 'decode' || kind === 'prefill', label = kind ? liveLabel(kind, s) : SERVER_WIDE;
  return {
    instrument, speeds: presentSpeeds(s), title, attr: kind && LABELLED.has(kind) ? { chip: attrChip(label, false, s.chatRuntime), tip: attrTip('attr', label, snapshot, live, s.chatRuntime) } : null,
    body, engineTrend,
    firstToken: kind && ACTIVE.has(snapshot.runtime.phase) && snapshot.runtime.request?.ttftMs != null && snapshot.capabilities['request.ttft']
      ? { text: 'First token', strong: dur(snapshot.runtime.request.ttftMs), basis: snapshot.capabilities['request.ttft'].basis } : null,
    context: kind ? contextBlock(s) : null, reply,
  };
};

const presentTiles = (s: ScopeInput): Tile[] => {
  const snapshot = s.snapshot, request = snapshot?.runtime.request, server = snapshot?.runtime.server;
  if (!snapshot || !request || s.paused || !s.fresh || !snapshot.capabilities['request.tokens'] || heroKind(s) === null) return [];
  const tiles: Tile[] = [];
  // While prefill runs there is no output yet, and the prompt size is the prefill line: three tiles.
  if (request.outputTokens != null) tiles.push({ label: 'Output', value: kt(request.outputTokens), detail: 'tokens so far', meter: null });
  if (request.elapsedMs != null) tiles.push({ label: 'Elapsed', value: dur(request.elapsedMs), detail: 'since it started', meter: null });
  if (request.promptTokens && request.cachedTokens != null) {
    const reused = request.cachedTokens / request.promptTokens;
    tiles.push({ label: 'Input reused', value: pct(reused), detail: `${kt(request.cachedTokens)} cached`, meter: reused });
  }
  if (server?.active != null) tiles.push({ label: 'Requests', value: String(server.active), detail: server.queued ? `${server.queued} queued` : 'Queue clear', meter: null });
  return tiles;
};

const SHORT = { gpuMem: 'GPU memory', power: 'Chip power' } as const;
export const presentMac = (s: ScopeInput): MacView | null => {
  const snapshot = s.snapshot, host = snapshot?.host;
  if (!snapshot || !host || s.paused) return null;
  const mac = host.mac, memory = snapshot.runtime.memory, rt = rtName(snapshot.connection), request = snapshot.runtime.request;
  const model = memory.modelBytes ?? memory.metalBytes, kind = memory.modelBytes != null ? 'model memory' : 'GPU allocations';
  const perJ = request?.decodeTps && snapshot.runtime.server.active === 1 && host.power && host.power.coverageFraction >= .8 && host.power.chipW > 0
    ? request.decodeTps / host.power.chipW : null;
  const macOS = host.platform === undefined || host.platform === 'macOS';
  const line: MacView['line'] = [
    ...host.cpuFraction != null ? [{ label: 'CPU', value: pct(host.cpuFraction), meter: host.cpuFraction }] : [],
    ...host.memUsedBytes != null && host.memTotalBytes ? [{ label: 'Memory allocated', value: `${(host.memUsedBytes / 1024 ** 3).toFixed(1)} / ${Math.round(host.memTotalBytes / 1024 ** 3)} GiB`,
      meter: host.memUsedBytes / host.memTotalBytes }] : [],
    ...mac?.swapUsedBytes != null ? [{ label: 'Swap', value: size(mac.swapUsedBytes), meter: null }] : [],
  ];
  const row = (key: string, label: string, value: Val, extra: Partial<Pick<MacRow, 'level' | 'meter' | 'tip'>> = {}): MacRow =>
    ({ key, label, value, level: null, meter: null, tip: null, ...extra });
  const rows: MacRow[] = [];
  if (mac?.pressureLevel) {
    const [word, level] = PRESSURE[mac.pressureLevel];
    rows.push(row('pressure', 'Memory pressure', { text: word, basis: 'reported' }, { level }));
  }
  if (host.thermal) {
    const level = host.thermal.level;
    rows.push(row('thermal', 'Heat status', { text: THERMAL[level]![0], basis: 'reported' }, { level: thermalLevel(level),
      tip: tip('thermal', 'Heat status', [`macOS reports heat level ${level} of 4 (“${THERMAL[level]![1]}”).`,
        `Scope warns from ${THERMAL[THERMAL_WARN]![0]} (level ${THERMAL_WARN}) up.`]) }));
  }
  const details: MacRow[] = [];
  if (host.gpu?.busyFraction != null) details.push(row('gpu-busy', 'GPU busy', { text: pct(host.gpu.busyFraction), basis: 'reported' }, { meter: host.gpu.busyFraction }));
  if (host.gpu?.allocBytes != null) details.push(row('gpu-mem', SHORT.gpuMem, { text: size(host.gpu.allocBytes), basis: 'reported' }));
  if (model != null && mac?.wiredLimitBytes) details.push(row('wired', `${rt} ${kind} / GPU memory limit`,
    { text: `${pct(model / mac.wiredLimitBytes)} of ${size(mac.wiredLimitBytes)}`, basis: heldBySource(snapshot) ? 'last-observed' : 'reported' }, { meter: Math.min(1, model / mac.wiredLimitBytes) }));
  if (host.runtimeProcess) details.push(row('footprint', `${RT[host.runtimeProcess.runtime]} process memory (:${host.runtimeProcess.port})`,
    { text: size(host.runtimeProcess.footprintBytes), basis: 'observed', note: 'macOS measurement' }));
  if (host.power) details.push(row('power', SHORT.power, { text: `${host.power.chipW.toFixed(1)} W`, basis: 'estimate' }));
  if (perJ !== null) details.push(row('tokj', 'Tokens per joule · this request', { text: perJ.toFixed(2), basis: 'estimate' }));
  return {
    title: macOS ? 'This Mac' : 'This computer', stale: !s.fresh, line, rows, details,
    tip: tip('mac', macOS ? 'This Mac' : 'This computer', ['Whole machine. Memory allocated is physical memory minus free memory. Includes memory macOS can reuse; differs from Activity Monitor’s Memory Used.',
      (host.gpu?.busyFraction != null || host.gpu?.allocBytes != null) && 'GPU readings come from macOS and do not trigger warnings. GPU memory includes reserves and other apps, not just the model.',
      model != null && !!mac?.wiredLimitBytes && `The GPU memory limit comparison uses ${rt}’s ${kind}; it does not trigger warnings.`,
      host.power ? 'macmon estimates power used by all parts of the chip across all apps, not power at the wall. Tokens per joule is generation speed divided by chip watts, shown only while one request is generating.'
        : macOS && 'Chip power needs macmon; Scope never installs it.',
      !s.fresh && 'Last reading · not live.']),
  };
};

export const presentLive = (s: ScopeInput, extra: readonly Callout[] = []): LiveView => {
  const chatOnly = s.measurementScope !== 'engine' && s.chatIsLocal === false;
  return { callouts: chatOnly ? [...extra] : callouts(s.snapshot, s.now, extra), hero: presentHero(s),
    tiles: chatOnly ? [] : presentTiles(s), mac: chatOnly ? null : presentMac(s) };
};
