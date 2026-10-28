import type { SpeedsView } from './speeds.ts';
import type { Basis } from '../../src/contract/capabilities.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import type { AttributionLabel } from '../attribution/join.ts';
import { liveChart, type ChartView } from '../render/chart.ts';
import { connName, PRESSURE, RT, rtName, statusCopy, THERMAL, THERMAL_WARN, thermalLevel, type Level } from './copy.ts';
import { ago, delta, dur, int, kt, mmss, pct, size, tps } from './format.ts';
import { attrChip, attrTip, callouts, splashRateTip, tip, value, weightedTps, type Callout, type Chip, type Tip, type Val } from './parts.ts';
export { weightedTps } from './parts.ts';
import { chatOnlyView, heldBySource, liveSplashRate, modelOf, SERVER_WIDE, SPLASH_WAITING, type ScopeInput } from './scope.ts';
import { presentSessionSection, type SessionSectionView } from './session.ts';
import { presentServer, type ServerView } from './server.ts';
import { fromSnapshot } from './reading.ts';
import { modelDisplayName } from './model-name.ts';

// The Live tab (plan §5.9, the G2 mock): callouts, the hero (one speed with its basis ⓘ, the attribution chip and the
// last reply), the request tiles and the This Mac card with the short labels (full wording in its ⓘ).

export type HeroKind = 'prefill' | 'decode' | 'server-decode' | 'busy' | 'slots' | 'ollama' | 'server' | 'queued' | 'processing' | 'inventory' | 'idle';
export type HeroBody =
  | { kind: 'paused'; note: string }
  | { kind: 'prefill'; fraction: number; counts: string | null; eta: string | null; tip: Tip }
  | { kind: 'decode'; tip: Tip }
  | { kind: 'word'; unit: string; note: Val | null };
export interface ReplyView {
  chip: Chip | null; tip: Tip | null; when: string | null; empty: string | null;
  values: Val[]; split: Val[]; usual: Chip | null; model?: string;
}
export interface HeroView { instrument: SessionSectionView; speeds: SpeedsView; title: string; model?: string | null; chatOnly?: boolean; attr: { chip: Chip; tip: Tip } | null; body: HeroBody | null; engineTrend: { chart: ChartView | null; current?: boolean } | null; firstToken: Val | null; context: { used: string; basis: Basis; fraction: number; tip: Tip } | null; reply: ReplyView | null }
export interface Tile { label: string; value: string; detail: string; meter: number | null; basis?: Basis }
export interface MacRow { key: string; label: string; value: Val; level: Level | null; meter: number | null; tip: Tip | null }
export interface MacView { title: string; tip: Tip; stale: boolean; line: Array<{ label: string; value: string; meter: number | null }>; rows: MacRow[]; details: MacRow[] }
export interface LiveView { callouts: Callout[]; hero: HeroView | null; tiles: Tile[]; mac: MacView | null; server: ServerView | null }

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
  const word = (unit: string, note: Val | null = null): HeroBody => ({ kind: 'word', unit, note });
  switch (kind) {
    case 'prefill': {
      const fraction = request!.prefillFraction!, stale = request!.prefillStale === true;
      const done = request!.prefillProcessedTokens, total = request!.prefillTotalTokens;
      return { kind: 'prefill', fraction, counts: done != null && total != null ? `${int(done)} of ${int(total)} ${snapshot.connection.runtime === 'splash' ? 'prompt tokens processed' : 'new tokens read'}` : null,
        eta: !stale && request!.prefillEtaMs != null ? dur(request!.prefillEtaMs) : null, tip: tip('basis', `From ${rt}`, [`${rt} reports how much of this prompt has been read.`,
          request!.prefillEtaMs != null && `${rt} estimates the finish time; it changes during prefill.`, stale && 'Progress has not updated yet.']) };
    }
    case 'decode': {
      const basis = snapshot.capabilities['request.decodeRate']?.basis ?? 'reported';
      const source = basis === 'reported' ? `From ${rt}` : `${basis === 'observed' ? 'Measured' : basis === 'derived' ? 'Calculated' : basis === 'estimate' ? 'Estimated' : 'Last reading'} from ${rt}`;
      return { kind: 'decode',
        tip: tip('basis', source, [basis === 'reported' ? `${rt} reports this request’s average speed, without Scope smoothing or estimates.` : 'Calculated from server readings. This is an average for the request.']) };
    }
    case 'server-decode': return { kind: 'decode', tip: splashRateTip('basis', server.rates!.windowMs) };
    case 'slots': case 'busy': {
      if (snapshot.connection.runtime === 'splash') return word(SPLASH_WAITING);
      const rates = server.rates;
      return word(`Speed unavailable for one request: ${active} ${kind === 'slots' ? 'slots are busy' : 'requests are running'}`,
        rates?.decodeTps != null ? { text: `Generation `, strong: `${tps(rates.decodeTps)} tok/s`, unit: `over the last ${Math.round(rates.windowMs / 1_000)} s`,
          basis: 'derived', note: `Calculated from ${rt}` } : null);
    }
    case 'ollama': return word('Ollama lists loaded models but does not provide request speeds');
    case 'server': return word(queued ? `${queued} waiting` : 'Nothing waiting');
    case 'queued': return word(`${queued} waiting · ${active} running`);
    case 'processing': return word(snapshot.connection.runtime === 'splash' ? runtime.phase === 'prefill' ? 'Reading prompt · waiting for update' : SPLASH_WAITING : `${rt} doesn’t report this request’s speed`);
    case 'inventory': return word(`${rt} lists its models · no live request readings`);
    default: return word('Model loaded · ready for the next request');
  }
};

const contextBlock = (s: ScopeInput): HeroView['context'] => {
  const request = s.snapshot?.runtime.request;
  if (!s.snapshot || !ACTIVE.has(s.snapshot.runtime.phase) || !request?.contextWindowTokens || request.contextUsedTokens == null) return null;
  return { used: `${kt(request.contextUsedTokens)} of ${kt(request.contextWindowTokens)} tokens`, basis: s.snapshot.capabilities['request.context']?.basis ?? 'reported', fraction: Math.min(1, request.contextUsedTokens / request.contextWindowTokens),
    tip: tip('ctx', 'Context used', ['Prompt and output tokens compared with the model’s context limit.', 'OpenCode may shorten the chat before this limit.']) };
};

const usualChip = (s: ScopeInput): Chip | null => {
  const flag = s.last?.flag, usual = s.last?.vsUsual;
  if (flag) return { text: `Slower · ${delta(flag.recentMedian / flag.p50 - 1)} · last 3`, tone: 'warn', basis: 'derived' };
  return usual ? { text: `${delta(usual.ratio - 1)} vs usual`, basis: 'derived' } : null;
};
const replyView = (s: ScopeInput): ReplyView | null => {
  const snapshot = s.snapshot!, rt = rtName(snapshot.connection);
  if (!snapshot.capabilities['server.completions'] || s.paused) return null;
  const last = s.last;
  if (!last) return { chip: null, tip: null, when: null, empty: 'No replies yet · replies appear while Scope is open', values: [], split: [], usual: null };
  const c = last.completion, flag = last.flag, usual = last.vsUsual;
  return {
    chip: attrChip(last.label), model: c.model ? modelDisplayName(c.model, snapshot.connection.modelNames) : undefined, when: ago(c.finishedAt, s.now), empty: null, split: [], usual: usualChip(s),
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
  // The full page takes the same at-rest facts the glance uses, so an idle engine shows its labelled record here too.
  const instrument = presentSessionSection({ ...s, reading: fromSnapshot(snapshot), chatIsLocal: s.chatIsLocal ?? null, restingFacts: true });
  const base = { instrument, speeds: instrument.speeds, attr: null, body: null, engineTrend: null, firstToken: null, context: null, reply: null };
  if (chatOnlyView(s)) return { ...base, title: 'This chat', chatOnly: true };
  const kind = heroKind(s), reported = modelOf(snapshot), model = reported ? modelDisplayName(reported, snapshot.connection.modelNames) : null;
  const title = model ?? connName(snapshot.connection), body = kind ? heroBody(kind, s) : null;
  // Keep the disclosure in place across lifecycle changes. Only compatible engine readings enter its chart.
  const engineTrend = snapshot.capabilities['request.decodeRate'] || snapshot.capabilities['server.rates']
    ? { current: s.fresh && !s.paused, chart: liveChart(s.samples, s.now, snapshot.connection.runtime === 'splash' ? null : s.turnStartAt,
      snapshot.connection.runtime === 'splash' ? 'server' : 'request') } : null;
  if (s.paused) return { ...base, speeds: instrument.speeds, title, model, body: { kind: 'paused', note: 'Nothing is read while paused, so no reply is recorded.' }, engineTrend };
  const reply = replyView(s);

  const live = kind === 'decode' || kind === 'prefill', label = kind ? liveLabel(kind, s) : SERVER_WIDE;
  return {
    instrument, speeds: instrument.speeds, title, model, attr: kind && LABELLED.has(kind) ? { chip: attrChip(label, false, s.chatRuntime), tip: attrTip('attr', label, snapshot, live, s.chatRuntime) } : null,
    body, engineTrend,
    firstToken: kind && ACTIVE.has(snapshot.runtime.phase) && snapshot.runtime.request?.ttftMs != null && snapshot.capabilities['request.ttft']
      ? { text: 'First token', strong: dur(snapshot.runtime.request.ttftMs), basis: snapshot.capabilities['request.ttft'].basis } : null,
    context: kind ? contextBlock(s) : null, reply,
  };
};

/** The same metric shape is used by current and retained facts. */
export const tile = (label: string, value: string, detail = '', meter: number | null = null, basis?: Basis): Tile =>
  ({ label, value, detail, meter, ...basis ? { basis } : {} });

const presentTiles = (s: ScopeInput): Tile[] => {
  const snapshot = s.snapshot, request = snapshot?.runtime.request, server = snapshot?.runtime.server;
  if (!snapshot || s.paused || !s.fresh || heroKind(s) === null) return [];
  const tiles: Tile[] = [];
  if (!request || !snapshot.capabilities['request.tokens']) {
    if (server?.active != null && snapshot.capabilities['server.requests']) tiles.push(tile('Active requests', String(server.active), server.queued ? `${server.queued} queued` : 'Queue clear', null, snapshot.capabilities['server.requests']!.basis));
    const memory = snapshot.runtime.memory, allocation = memory.modelBytes ?? memory.metalBytes;
    const memoryCap = snapshot.capabilities[memory.modelBytes != null ? 'server.memory.model' : 'server.memory.metal'];
    if (allocation != null && memoryCap) tiles.push(tile(memory.modelBytes != null ? 'Model memory' : 'Metal allocations', size(allocation), 'engine allocations', null, memoryCap.basis));
    const latency = server?.histograms?.ttftMs;
    if (latency && snapshot.capabilities['server.latency']) tiles.push(tile('Median first token', dur(latency.p50), `${latency.n} recent requests`, null, snapshot.capabilities['server.latency']!.basis));
    return tiles;
  }
  // While prefill runs there is no output yet, and the prompt size is the prefill line: three tiles.
  if (request.outputTokens != null) tiles.push(tile('Output', kt(request.outputTokens), 'tokens so far'));
  if (request.elapsedMs != null) tiles.push(tile('Elapsed', dur(request.elapsedMs), 'since it started'));
  if (request.promptTokens && request.cachedTokens != null) {
    const reused = request.cachedTokens / request.promptTokens;
    tiles.push(tile('Input reused', pct(reused), `${kt(request.cachedTokens)} cached`, reused));
  }
  if (server?.active != null) tiles.push(tile('Requests', String(server.active), server.queued ? `${server.queued} queued` : 'Queue clear'));
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
    rows.push(row('pressure', 'Memory pressure', value(word), { level }));
  }
  if (host.thermal) {
    const level = host.thermal.level;
    rows.push(row('thermal', 'Heat status', value(THERMAL[level]![0]), { level: thermalLevel(level),
      tip: tip('thermal', 'Heat status', [`macOS reports heat level ${level} of 4 (“${THERMAL[level]![1]}”).`,
        `Scope warns from ${THERMAL[THERMAL_WARN]![0]} (level ${THERMAL_WARN}) up.`]) }));
  }
  const details: MacRow[] = [];
  if (host.gpu?.busyFraction != null) details.push(row('gpu-busy', 'GPU busy', value(pct(host.gpu.busyFraction)), { meter: host.gpu.busyFraction }));
  if (host.gpu?.allocBytes != null) details.push(row('gpu-mem', SHORT.gpuMem, value(size(host.gpu.allocBytes))));
  if (model != null && mac?.wiredLimitBytes) details.push(row('wired', `${rt} ${kind} / GPU memory limit`,
    value(`${pct(model / mac.wiredLimitBytes)} of ${size(mac.wiredLimitBytes)}`, heldBySource(snapshot) ? 'last-observed' : 'reported'), { meter: Math.min(1, model / mac.wiredLimitBytes) }));
  if (host.runtimeProcess) details.push(row('footprint', `${RT[host.runtimeProcess.runtime]} process memory (:${host.runtimeProcess.port})`,
    value(size(host.runtimeProcess.footprintBytes), 'observed', 'macOS measurement')));
  if (host.power) details.push(row('power', SHORT.power, value(`${host.power.chipW.toFixed(1)} W`, 'estimate')));
  if (perJ !== null) details.push(row('tokj', 'Tokens per joule · this request', value(perJ.toFixed(2), 'estimate')));
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
  const chatOnly = chatOnlyView(s);
  // The server rows nest inside the hub, so their callouts must not repeat the view's own.
  return { callouts: chatOnly ? [...extra] : callouts(s.snapshot, s.now, extra), hero: presentHero(s),
    tiles: chatOnly ? [] : presentTiles(s), mac: chatOnly ? null : presentMac(s),
    server: chatOnly ? null : presentServer(s.snapshot, s.now, [], s.fresh && !s.paused) };
};
