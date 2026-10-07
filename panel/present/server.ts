import type { CapabilityKey } from '../../src/contract/capabilities.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import { connName, PHASE, rtName } from './copy.ts';
import { clock, dur, int, kt, pct, size, tps } from './format.ts';
import { callouts, tip, type Callout, type Chip, type Tip, type Val } from './parts.ts';
import { heldBySource, liveSplashRate } from './scope.ts';
import { SPLASH_SPEED_HELP } from './speeds.ts';

// The Server tab (plan §5.9, G2 mock): the runtime card with its detection basis, then only the cards the runtime can
// fill: slots, throughput, speculative decoding, native latency, memory and ceiling, cache, residency or lms instances,
// the Engines card, the model inventory and the server session. A card without a reading is left out, never zeroed.

export type Block =
  | { kind: 'kv'; rows: Array<{ label: string; value: string; chips?: Chip[] }> }
  | { kind: 'values'; cols: 2 | 3; big?: boolean; items: Array<{ label: string; value: Val; small?: string }> }
  | { kind: 'meter'; fraction: number }
  | { kind: 'bar'; fraction: number }
  | { kind: 'list'; items: Array<{ title: string; loaded: boolean; chips: Chip[]; reading: string[]; meter: number | null }>; chipGroup?: boolean };
export interface ServerCard { key: string; title: string; right: string; tip: Tip | null; blocks: Block[] }
export interface ServerView { callouts: Callout[]; cards: ServerCard[] }

const v = (text: string, basis: Val['basis'] = 'reported', note?: string): Val => ({ text, basis, ...note ? { note } : {} });
type ValueBlock = Extract<Block, { kind: 'values' }>;
const labelled = <T>(label: string, value: T, small?: string): { label: string; value: T; small?: string } => ({ label, value, ...small !== undefined ? { small } : {} });
const values = (items: ValueBlock['items'], cols: 2 | 3, big?: boolean): ValueBlock => ({ kind: 'values', cols, items, ...big !== undefined ? { big } : {} });
const card = (key: string, title: string, right: string, detail: Tip | string[] | null, blocks: Block[], tipKey = key): ServerCard =>
  ({ key, title, right, tip: Array.isArray(detail) ? tip(tipKey, title, detail) : detail, blocks });
const REPORTS: ReadonlyArray<readonly [CapabilityKey, string]> = [['request.decodeRate', 'per-request speed'], ['request.prefillProgress', 'prompt progress'],
  ['server.requests', 'request counts'], ['server.cache', 'cache'], ['server.memory.model', 'model memory'], ['server.memory.metal', 'GPU allocations'],
  ['server.averages', 'server averages'], ['server.latency', 'response timing'], ['server.slots', 'slots'], ['server.rates', 'speeds'],
  ['server.speculative', 'speculative decoding'], ['server.residency', 'loaded models'], ['server.engines', 'model software'], ['server.usage', 'usage history'],
  ['server.completions', 'replies']];
const STATE_WORD: Record<SnapshotV2['status']['state'], string> = { ready: 'Ready', degraded: 'Limited', recovering: 'Recovering', failing: 'Not responding', detecting: 'Detecting', unconfigured: 'Not set up' };
const RECORDED: Record<string, string> = { reported: 'From server', 'last-observed': 'Last reading', derived: 'Calculated', observed: 'Measured', estimate: 'Estimated' };

const runtimeCard = (s: SnapshotV2): ServerCard => {
  const c = s.connection, reports = REPORTS.filter(([key]) => s.capabilities[key]).map(([, text]) => ({ text })), replies = s.capabilities['server.completions'];
  const rows: Array<{ label: string; value: string; chips?: Chip[] }> = [labelled('Server', connName(c))];
  if (c.runtime) rows.push(labelled('Version', c.version ?? 'Not reported'));
  if (c.engine) rows.push(labelled('Model software', c.engine === 'splash' ? 'Splash' : c.engine));
  rows.push(labelled('Detected', c.detection.probe ? `${c.detection.probe} answered · ${c.detection.confidence} confidence`
    : c.detection.basis === 'explicit' ? 'Chosen under Connection' : c.detection.basis === 'hint' ? `From its connection name · ${c.detection.confidence} confidence` : `${c.detection.confidence} confidence`));
  rows.push({ label: 'Reports', value: reports.length ? '' : 'Nothing yet', chips: reports });
  if (c.runtime) rows.push(labelled('Replies recorded as', replies ? RECORDED[replies.basis] ?? replies.basis : `None · ${rtName(c)} doesn’t report them`));
  return card('runtime', 'Server', s.status.reason === 'sleeping' ? 'Asleep' : STATE_WORD[s.status.state], null, [{ kind: 'kv', rows }]);
};
const memoryCard = (s: SnapshotV2): ServerCard | null => {
  const m = s.runtime.memory, held = heldBySource(s);
  if (m.metalBytes != null) return card('memory', 'Model memory', `Splash · ${held ? 'last reading' : 'from server'}`, ['Splash reports memory used for GPU work separately from its process memory. This Mac compares it with the macOS limit for GPU work.'], [values([labelled('GPU allocations', v(size(m.metalBytes))), ...m.metalPeakBytes != null ? [labelled('Peak GPU allocations', v(size(m.metalPeakBytes)))] : []], 2)], 'mem');
  if (m.modelBytes == null && m.processBytes == null) return null;
  const items = [...m.modelBytes != null ? [labelled('Model memory', v(size(m.modelBytes)))] : [],
    ...m.ceilingBytes != null ? [labelled('Model memory limit', v(size(m.ceilingBytes)))] : m.processBytes != null ? [labelled('Process memory', v(size(m.processBytes)))] : []];
  return card('memory', 'Model memory', `${rtName(s.connection)} · from server`, [`${rtName(s.connection)}’s memory use${m.ceilingBytes != null ? ' and model memory limit' : ''} across all requests.`,
      'This Mac shows process memory and the macOS limit for GPU work.'], [{ kind: 'values', cols: 2, items }, ...m.modelBytes != null && m.ceilingBytes ? [{ kind: 'meter' as const, fraction: Math.min(1, m.modelBytes / m.ceilingBytes) }] : []], 'mem');
};
const cacheCard = (s: SnapshotV2): ServerCard | null => {
  const request = s.runtime.request, c = s.runtime.server.cache;
  if (!c) return null;
  const reuse = request?.promptTokens && request.cachedTokens != null ? request : null;
  const cacheItems = [...c.ramBytes != null ? [labelled('RAM cache', v(size(c.ramBytes)), c.ramEntries != null ? `${int(c.ramEntries)} entries` : undefined)] : [],
    ...c.ssdBytes != null ? [labelled('SSD cache', v(size(c.ssdBytes)), c.ssdEntries != null ? `${int(c.ssdEntries)} entries` : undefined)] : []];
  return card('cache', 'Cache & input', reuse ? 'Current request' : 'Server cache', ['From server counts for this request. Input that was not reused can differ from the tokens read during prefill.'], [...reuse ? [values([labelled('Reused tokens', v(int(reuse.cachedTokens!))),
      labelled('Not reused', v(int(reuse.promptTokens! - reuse.cachedTokens!)))], 2 as const, true), { kind: 'bar' as const, fraction: reuse.cachedTokens! / reuse.promptTokens! }] : [],
    ...cacheItems.length ? [values(cacheItems, 2 as const)] : []]);
};
const residencyCard = (s: SnapshotV2, now: number): ServerCard | null => {
  const list = s.runtime.residency;
  if (!list.length) return null;
  const source = list[0]!.source, many = list.length > 1;
  const items = list.map(m => m.source === 'ollama-ps' ? {
    title: m.model, loaded: true, chips: m.unloadsAt != null ? [{ text: `unloads in ${dur(Math.max(0, m.unloadsAt - now))}` }] : [],
    reading: [...m.bytes != null ? [`${size(m.bytes)} loaded`] : [], ...m.gpuResidentBytes != null ? [`GPU memory (from Ollama) ${size(m.gpuResidentBytes)}${m.bytes ? ` · ${pct(m.gpuResidentBytes / m.bytes)}` : ''}`] : []],
    meter: m.gpuResidentBytes != null && m.bytes ? Math.min(1, m.gpuResidentBytes / m.bytes) : null,
  } : {
    title: m.model, loaded: true, chips: [{ text: PHASE[m.phase], ...m.phase !== 'idle' ? { tone: 'accent' as const } : {} }],
    reading: (source === 'lms-ps' || many) && m.bytes != null ? [`${size(m.bytes)} ${source === 'lms-ps' ? 'loaded' : 'allocated'}`] : [], meter: null,
  });
  const title = source === 'lms-ps' ? 'Loaded instances' : 'Loaded models';
  const count = s.runtime.residencyCount ?? list.length;
  return { key: 'residency', title, right: source === 'lms-ps' ? 'lms ps · refreshed on load/unload' : `${count} loaded`,
    tip: tip('resident', title, source === 'ollama-ps' ? ['Ollama reports memory used by GPU work. Apple silicon shares one memory pool; this is not extra memory.']
      : source === 'lms-ps' ? ['LM Studio’s no-wake command never starts Bionic. Inventory lists context sizes and formats.']
        : ['Models loaded on this server, across all chats.', !many && 'The loaded model uses the memory shown above.']),
    blocks: [{ kind: 'list', items }] };
};
const sessionCard = (s: SnapshotV2, now: number): ServerCard | null => {
  const a = s.runtime.server.averages;
  if (!a) return null;
  const held = heldBySource(s), basis = held ? 'last-observed' as const : 'reported' as const;
  const since = held && s.status.sinceAt ? `before ${clock(s.status.sinceAt, now)}` : a.uptimeMs ? `${dur(a.uptimeMs)} · since start`
    : s.connection.runtime === 'lmstudio' ? 'Since the log stream started' : 'Since the server started';
  const items = [...a.decodeTps != null ? [labelled('Generation speed', v(`${tps(a.decodeTps)} tok/s`, basis))] : [],
    ...a.prefillTps != null ? [labelled('Prefill speed', v(`${tps(a.prefillTps)} tok/s`, basis))] : [],
    ...a.cacheEfficiencyFraction != null ? [labelled('Cache efficiency', v(pct(a.cacheEfficiencyFraction), basis))] : [],
    ...a.requestsTotal != null ? [labelled('Completed', v(int(a.requestsTotal), basis), a.failedTotal ? `${int(a.failedTotal)} failed` : undefined)] : []];
  return items.length ? card('session', 'Overall average', s.connection.runtime === 'splash' ? `${held ? 'Last reading · ' : ''}Since this model started` : since, [s.connection.runtime === 'splash' ? 'Since this model started, across all requests.' : 'From server totals across models and apps.'], [{ kind: 'values', cols: 2, items }]) : null;
};
const latencyCard = (s: SnapshotV2): ServerCard | null => {
  const h = s.runtime.server.histograms;
  if (!h || !h.ttftMs && !h.itlMs) return null;
  const q = (label: string, x: NonNullable<typeof h.ttftMs>) => (labelled(`${label} typical · slowest 5%`, v(`${dur(x.p50)} · ${dur(x.p95)}`), `${int(x.n)} readings`));
  return card('latency', 'Response timing', heldBySource(s) ? 'Splash · last reading' : 'From Splash', ['Splash’s last 4,096 readings across all apps. Typical means the middle reading; the second value is the cutoff for the slowest 5%. Scope’s usual-speed comparisons use the slowest 10% cutoff.'], [values([...h.ttftMs ? [q('First token', h.ttftMs)] : [], ...h.itlMs ? [q('Between tokens', h.itlMs)] : []], 2)]);
};
const slotsCard = (s: SnapshotV2): ServerCard | null => {
  const slots = s.runtime.slots;
  if (!slots.length) return null;
  const busy = slots.filter(slot => slot.busy).length;
  return card('slots', 'Slots', `${busy} of ${slots.length} busy`, ['No prompts read. Polls /slots only when /metrics shows work, preserving sleep.'], [{ kind: 'list', items: slots.map(slot => ({ title: `Slot ${slot.id}`, loaded: false, meter: null,
      chips: [{ text: slot.busy ? 'Busy' : 'Idle', ...slot.busy ? { tone: 'accent' as const } : {} }],
      reading: [slot.busy ? [slot.decodedTokens != null && `${int(slot.decodedTokens)} decoded`, slot.promptTokens != null && `${kt(slot.promptTokens)} prompt`].filter(Boolean).join(' · ') || 'Busy' : 'Waiting',
        `${kt(slot.contextWindowTokens)} context`] })) }]);
};
const ratesCard = (s: SnapshotV2): ServerCard | null => {
  const r = s.runtime.server.rates, server = s.runtime.server, splash = s.connection.runtime === 'splash';
  const decode = splash ? liveSplashRate(s) : r?.decodeTps, prompt = splash ? liveSplashRate(s, 'prefill') : r?.promptTps;
  if (!r || splash && decode == null && prompt == null) return null;
  const window = decode != null ? r.windowMs : r.promptWindowMs ?? r.windowMs;
  return card('rates', splash ? 'Recent speeds' : 'All server speeds', splash ? `All server activity · last ${dur(window)}` : `last ${Math.round(window / 1_000)} s`,
    splash ? tip('rates', 'How speeds are measured', SPLASH_SPEED_HELP)
      : tip('rates', 'All server speeds', [`Calculated from ${rtName(s.connection)} totals. Counts that reset at each update are excluded.`]),
    [values([...prompt != null ? [labelled('Prefill speed', v(`${tps(prompt)} tok/s`, 'derived'), splash ? `last ${dur(r.promptWindowMs ?? window)}` : undefined)] : [],
      ...decode != null ? [labelled('Generation speed', v(`${tps(decode)} tok/s`, 'derived'), splash ? `last ${dur(r.windowMs)}` : undefined)] : [],
      ...server.active != null ? [labelled('Processing · deferred', v(`${server.active} · ${server.queued ?? 0}`))] : []], splash ? 2 : 3)]);
};
const specCard = (s: SnapshotV2): ServerCard | null => {
  const sp = s.runtime.server.speculative;
  if (!sp) return null;
  return card('spec', 'Draft token reuse', `last ${Math.max(1, Math.round(sp.windowMs / 60_000))} min`, ['Across all llama-server requests. Acceptance is the share of draft tokens kept by the main model.'], [values([labelled('Draft acceptance', v(pct(sp.acceptanceFraction), 'derived')),
      labelled('Accepted', v(`${int(sp.acceptedTokens)} of ${int(sp.draftedTokens)}`))], 2), { kind: 'meter', fraction: sp.acceptanceFraction }]);
};
const enginesCard = (s: SnapshotV2): ServerCard | null => {
  const engines = s.runtime.engines;
  if (!engines.length) return null;
  return card('engines', 'Model software', 'LM Studio · checked every 10 min', ['Read from LM Studio. Scope never installs, selects or updates this software.'], [{ kind: 'list', items: engines.map(engine => ({ title: `${engine.name} ${engine.version}`, loaded: false, reading: [], meter: null,
      chips: [{ text: engine.selected ? 'In use' : 'Installed', ...engine.selected ? { tone: 'accent' as const } : {} }] })) }]);
};
const catalogCard = (s: SnapshotV2): ServerCard | null => {
  const catalog = s.runtime.catalog;
  if (!catalog.length) return null;
  return card('catalog', 'Model inventory', `${catalog.filter(model => model.loaded).length} loaded · ${catalog.length} listed`, null, [{ kind: 'list', chipGroup: true, items: catalog.map(model => ({ title: model.name, loaded: model.loaded === true, meter: null,
      chips: [...model.format ? [{ text: model.format, ...model.format === 'splash' ? { tone: 'accent' as const } : {} }] : [],
        ...model.vision ? [{ text: `vision${model.inputModalities?.length ? ` · ${model.inputModalities.join(' + ')}` : ''}` }] : []],
      reading: [model.loaded ? 'Loaded' : model.loaded === false ? 'Available' : 'Listed', ...model.contextWindowTokens ? [`${kt(model.contextWindowTokens)} context`] : []] })) }]);
};

export const presentServer = (snapshot: SnapshotV2 | null, now: number, extra: readonly Callout[] = [], fresh = true): ServerView => {
  if (!snapshot) return { callouts: callouts(null, now, extra), cards: [] };
  const cards = [runtimeCard(snapshot), slotsCard(snapshot), fresh || snapshot.connection.runtime !== 'splash' ? ratesCard(snapshot) : null, specCard(snapshot), latencyCard(snapshot), memoryCard(snapshot),
    cacheCard(snapshot), residencyCard(snapshot, now), enginesCard(snapshot), catalogCard(snapshot), sessionCard(snapshot, now)];
  return { callouts: callouts(snapshot, now, extra), cards: cards.filter((card): card is ServerCard => card !== null) };
};
