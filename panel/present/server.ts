import type { CapabilityKey } from '../../src/contract/capabilities.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import { connName, PHASE, rtName } from './copy.ts';
import { clock, dur, int, kt, pct, size, tps } from './format.ts';
import { callouts, tip, type Callout, type Chip, type Tip, type Val } from './parts.ts';
import { heldBySource } from './scope.ts';

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
const card = (key: string, title: string, right: string, tip: Tip | null, blocks: Block[]): ServerCard => ({ key, title, right, tip, blocks });
const REPORTS: ReadonlyArray<readonly [CapabilityKey, string]> = [['request.decodeRate', 'per-request speed'], ['request.prefillProgress', 'prefill progress'],
  ['server.requests', 'request counts'], ['server.cache', 'cache'], ['server.memory.model', 'model memory'], ['server.memory.metal', 'Metal memory'],
  ['server.averages', 'server averages'], ['server.latency', 'latency percentiles'], ['server.slots', 'slots'], ['server.rates', 'throughput'],
  ['server.speculative', 'speculative decoding'], ['server.residency', 'loaded models'], ['server.engines', 'engines'], ['server.usage', 'usage history'],
  ['server.completions', 'replies']];
const STATE_WORD: Record<SnapshotV2['status']['state'], string> = { ready: 'Ready', degraded: 'Limited', recovering: 'Recovering', failing: 'Not responding', detecting: 'Detecting', unconfigured: 'Not set up' };
const RECORDED: Record<string, string> = { reported: 'Reported by the runtime', 'last-observed': 'Last observed by Scope', derived: 'Derived from counters', observed: 'Observed by Scope', estimate: 'Estimated' };

const runtimeCard = (s: SnapshotV2): ServerCard => {
  const c = s.connection, reports = REPORTS.filter(([key]) => s.capabilities[key]).map(([, text]) => ({ text })), replies = s.capabilities['server.completions'];
  const rows: Array<{ label: string; value: string; chips?: Chip[] }> = [labelled('Runtime', connName(c))];
  if (c.runtime) rows.push(labelled('Version', c.version ?? 'Not reported'));
  if (c.engine) rows.push(labelled('Engine', c.engine === 'splash' ? 'Splash runtime pack' : c.engine));
  rows.push(labelled('Detected', c.detection.probe ? `${c.detection.probe} answered · ${c.detection.confidence} confidence`
    : c.detection.basis === 'explicit' ? 'Chosen under Connection' : c.detection.basis === 'hint' ? `From its connection name · ${c.detection.confidence} confidence` : `${c.detection.confidence} confidence`));
  rows.push({ label: 'Reports', value: reports.length ? '' : 'Nothing yet', chips: reports });
  if (c.runtime) rows.push(labelled('Replies recorded as', replies ? RECORDED[replies.basis] ?? replies.basis : `None · ${rtName(c)} doesn’t report them`));
  return card('runtime', 'Runtime', s.status.reason === 'sleeping' ? 'Asleep' : STATE_WORD[s.status.state], null, [{ kind: 'kv', rows }]);
};
const memoryCard = (s: SnapshotV2): ServerCard | null => {
  const m = s.runtime.memory, held = heldBySource(s);
  if (m.metalBytes != null) return card('memory', 'Runtime memory', `Splash · ${held ? 'last observed' : 'reported'}`, tip('mem', 'Runtime memory', ['Splash Metal allocation, separate from process memory. This Mac compares it with the macOS GPU wired limit.']), [values([labelled('Metal memory', v(size(m.metalBytes))), ...m.metalPeakBytes != null ? [labelled('Metal peak', v(size(m.metalPeakBytes)))] : []], 2)]);
  if (m.modelBytes == null && m.processBytes == null) return null;
  const items = [...m.modelBytes != null ? [labelled('Model memory', v(size(m.modelBytes)))] : [],
    ...m.ceilingBytes != null ? [labelled('Engine-pool ceiling', v(size(m.ceilingBytes)))] : m.processBytes != null ? [labelled('Process memory', v(size(m.processBytes)))] : []];
  return card('memory', 'Runtime memory', `${rtName(s.connection)} · reported`, tip('mem', 'Runtime memory', [`${rtName(s.connection)}’s reported allocation${m.ceilingBytes != null ? ' and engine-pool ceiling' : ''}; not per-chat.`,
      'This Mac shows process footprint and macOS GPU wired limit.']), [{ kind: 'values', cols: 2, items }, ...m.modelBytes != null && m.ceilingBytes ? [{ kind: 'meter' as const, fraction: Math.min(1, m.modelBytes / m.ceilingBytes) }] : []]);
};
const cacheCard = (s: SnapshotV2): ServerCard | null => {
  const request = s.runtime.request, c = s.runtime.server.cache;
  if (!c) return null;
  const reuse = request?.promptTokens && request.cachedTokens != null ? request : null;
  const cacheItems = [...c.ramBytes != null ? [labelled('RAM cache', v(size(c.ramBytes)), c.ramEntries != null ? `${int(c.ramEntries)} entries` : undefined)] : [],
    ...c.ssdBytes != null ? [labelled('SSD cache', v(size(c.ssdBytes)), c.ssdEntries != null ? `${int(c.ssdEntries)} entries` : undefined)] : []];
  return card('cache', 'Cache & input', reuse ? 'Current request' : 'Server cache', tip('cache', 'Cache & input', ['Runtime counts for this request. Unreused input need not equal a prefill stage.']), [...reuse ? [values([labelled('Reused tokens', v(int(reuse.cachedTokens!))),
      labelled('Not reused', v(int(reuse.promptTokens! - reuse.cachedTokens!)))], 2 as const, true), { kind: 'bar' as const, fraction: reuse.cachedTokens! / reuse.promptTokens! }] : [],
    ...cacheItems.length ? [values(cacheItems, 2 as const)] : []]);
};
const residencyCard = (s: SnapshotV2, now: number): ServerCard | null => {
  const list = s.runtime.residency;
  if (!list.length) return null;
  const source = list[0]!.source, many = list.length > 1;
  const items = list.map(m => m.source === 'ollama-ps' ? {
    title: m.model, loaded: true, chips: m.unloadsAt != null ? [{ text: `unloads in ${dur(Math.max(0, m.unloadsAt - now))}` }] : [],
    reading: [...m.bytes != null ? [`${size(m.bytes)} loaded`] : [], ...m.gpuResidentBytes != null ? [`GPU-resident (Ollama-reported) ${size(m.gpuResidentBytes)}${m.bytes ? ` · ${pct(m.gpuResidentBytes / m.bytes)}` : ''}`] : []],
    meter: m.gpuResidentBytes != null && m.bytes ? Math.min(1, m.gpuResidentBytes / m.bytes) : null,
  } : {
    title: m.model, loaded: true, chips: [{ text: PHASE[m.phase], ...m.phase !== 'idle' ? { tone: 'accent' as const } : {} }],
    reading: (source === 'lms-ps' || many) && m.bytes != null ? [`${size(m.bytes)} ${source === 'lms-ps' ? 'loaded' : 'allocated'}`] : [], meter: null,
  });
  const title = source === 'lms-ps' ? 'Loaded instances' : 'Loaded models';
  const count = s.runtime.residencyCount ?? list.length;
  return { key: 'residency', title, right: source === 'lms-ps' ? 'lms ps · refreshed on load/unload' : `${count} loaded`,
    tip: tip('resident', title, source === 'ollama-ps' ? ['Ollama reports GPU residency only. Apple silicon shares one memory pool; GPU-resident is not separate memory.']
      : source === 'lms-ps' ? ['LM Studio’s no-wake command never starts Bionic. Inventory lists context sizes and formats.']
        : ['Runtime-loaded models, not assigned to a chat.', !many && 'One loaded model uses the Runtime memory figure.']),
    blocks: [{ kind: 'list', items }] };
};
const sessionCard = (s: SnapshotV2, now: number): ServerCard | null => {
  const a = s.runtime.server.averages;
  if (!a) return null;
  const held = heldBySource(s), basis = held ? 'last-observed' as const : 'reported' as const;
  const since = held && s.status.sinceAt ? `before ${clock(s.status.sinceAt, now)}` : a.uptimeMs ? `${dur(a.uptimeMs)} · since start`
    : s.connection.runtime === 'lmstudio' ? 'Since the log stream started' : 'Since the runtime started';
  const items = [...a.decodeTps != null ? [labelled('Decode average', v(`${tps(a.decodeTps)} tok/s`, basis))] : [],
    ...a.prefillTps != null ? [labelled('Prefill average', v(`${tps(a.prefillTps)} tok/s`, basis))] : [],
    ...a.cacheEfficiencyFraction != null ? [labelled('Cache efficiency', v(pct(a.cacheEfficiencyFraction), basis))] : [],
    ...a.requestsTotal != null ? [labelled('Completed', v(int(a.requestsTotal), basis), a.failedTotal ? `${int(a.failedTotal)} failed` : undefined)] : []];
  return items.length ? card('session', 'Server session', since, tip('session', 'Server session', ['Runtime-reported totals across all models and apps.']), [{ kind: 'values', cols: 2, items }]) : null;
};
const latencyCard = (s: SnapshotV2): ServerCard | null => {
  const h = s.runtime.server.histograms;
  if (!h || !h.ttftMs && !h.itlMs) return null;
  const q = (label: string, x: NonNullable<typeof h.ttftMs>) => (labelled(`${label} p50 · p95`, v(`${dur(x.p50)} · ${dur(x.p95)}`), `n ${int(x.n)}`));
  return card('latency', 'Latency', heldBySource(s) ? 'Splash native · last observed' : 'Splash native', tip('latency', 'Latency', ['Splash’s last 4,096 samples across all clients. Splash uses p95; Scope baselines use p90.']), [values([...h.ttftMs ? [q('TTFT', h.ttftMs)] : [], ...h.itlMs ? [q('Between tokens', h.itlMs)] : []], 2)]);
};
const slotsCard = (s: SnapshotV2): ServerCard | null => {
  const slots = s.runtime.slots;
  if (!slots.length) return null;
  const busy = slots.filter(slot => slot.busy).length;
  return card('slots', 'Slots', `${busy} of ${slots.length} busy`, tip('slots', 'Slots', ['No prompts read. /slots is polled only when /metrics shows work, preserving sleep.']), [{ kind: 'list', items: slots.map(slot => ({ title: `Slot ${slot.id}`, loaded: false, meter: null,
      chips: [{ text: slot.busy ? 'Busy' : 'Idle', ...slot.busy ? { tone: 'accent' as const } : {} }],
      reading: [slot.busy ? [slot.decodedTokens != null && `${int(slot.decodedTokens)} decoded`, slot.promptTokens != null && `${kt(slot.promptTokens)} prompt`].filter(Boolean).join(' · ') || 'Busy' : 'Waiting',
        `${kt(slot.contextWindowTokens)} context`] })) }]);
};
const ratesCard = (s: SnapshotV2): ServerCard | null => {
  const r = s.runtime.server.rates, server = s.runtime.server;
  if (!r) return null;
  return card('rates', 'Server throughput', `last ${Math.round(r.windowMs / 1_000)} s`, tip('rates', 'Server throughput', [`Derived from ${rtName(s.connection)} totals, not gauges that reset on each scrape.`]), [values([...r.promptTps != null ? [labelled('Prompt', v(`${int(r.promptTps)} tok/s`, 'derived'))] : [],
      ...r.decodeTps != null ? [labelled('Decode', v(`${tps(r.decodeTps)} tok/s`, 'derived'))] : [],
      ...server.active != null ? [labelled('Processing · deferred', v(`${server.active} · ${server.queued ?? 0}`))] : []], 3)]);
};
const specCard = (s: SnapshotV2): ServerCard | null => {
  const sp = s.runtime.server.speculative;
  if (!sp) return null;
  return card('spec', 'Speculative decoding', `last ${Math.max(1, Math.round(sp.windowMs / 60_000))} min`, tip('spec', 'Speculative decoding', ['Server-wide llama-server counters. Acceptance is the share of draft tokens the main model keeps.']), [values([labelled('Draft acceptance', v(pct(sp.acceptanceFraction), 'derived')),
      labelled('Accepted', v(`${int(sp.acceptedTokens)} of ${int(sp.draftedTokens)}`))], 2), { kind: 'meter', fraction: sp.acceptanceFraction }]);
};
const enginesCard = (s: SnapshotV2): ServerCard | null => {
  const engines = s.runtime.engines;
  if (!engines.length) return null;
  return card('engines', 'Engines', 'lms runtime ls · cached 10 min', tip('engines', 'Engines', ['Read only in Server & Mac details. Scope never installs, selects or updates engines.']), [{ kind: 'list', items: engines.map(engine => ({ title: `${engine.name} ${engine.version}`, loaded: false, reading: [], meter: null,
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

export const presentServer = (snapshot: SnapshotV2 | null, now: number, extra: readonly Callout[] = []): ServerView => {
  if (!snapshot) return { callouts: callouts(null, now, extra), cards: [] };
  const cards = [runtimeCard(snapshot), slotsCard(snapshot), ratesCard(snapshot), specCard(snapshot), latencyCard(snapshot), memoryCard(snapshot),
    cacheCard(snapshot), residencyCard(snapshot, now), enginesCard(snapshot), catalogCard(snapshot), sessionCard(snapshot, now)];
  return { callouts: callouts(snapshot, now, extra), cards: cards.filter((card): card is ServerCard => card !== null) };
};
