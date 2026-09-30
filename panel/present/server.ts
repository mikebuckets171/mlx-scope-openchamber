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
const REPORTS: ReadonlyArray<readonly [CapabilityKey, string]> = [['request.decodeRate', 'per-request speed'], ['request.prefillProgress', 'prefill progress'],
  ['server.requests', 'request counts'], ['server.cache', 'cache'], ['server.memory.model', 'model memory'], ['server.memory.metal', 'Metal memory'],
  ['server.averages', 'server averages'], ['server.latency', 'latency percentiles'], ['server.slots', 'slots'], ['server.rates', 'throughput'],
  ['server.speculative', 'speculative decoding'], ['server.residency', 'loaded models'], ['server.engines', 'engines'], ['server.usage', 'usage history'],
  ['server.completions', 'replies']];
const STATE_WORD: Record<SnapshotV2['status']['state'], string> = { ready: 'Ready', degraded: 'Limited', recovering: 'Recovering', failing: 'Not responding', detecting: 'Detecting', unconfigured: 'Not set up' };
const RECORDED: Record<string, string> = { reported: 'Reported by the runtime', 'last-observed': 'Last observed by Scope', derived: 'Derived from counters', observed: 'Observed by Scope', estimate: 'Estimated' };

const runtimeCard = (s: SnapshotV2): ServerCard => {
  const c = s.connection, reports = REPORTS.filter(([key]) => s.capabilities[key]).map(([, text]) => ({ text })), replies = s.capabilities['server.completions'];
  const rows: Array<{ label: string; value: string; chips?: Chip[] }> = [{ label: 'Runtime', value: connName(c) }];
  if (c.runtime) rows.push({ label: 'Version', value: c.version ?? 'Not reported' });
  if (c.engine) rows.push({ label: 'Engine', value: c.engine === 'splash' ? 'Splash runtime pack' : c.engine });
  rows.push({ label: 'Detected', value: c.detection.probe ? `${c.detection.probe} answered · ${c.detection.confidence} confidence`
    : c.detection.basis === 'explicit' ? 'Chosen under Connection' : c.detection.basis === 'hint' ? `From its connection name · ${c.detection.confidence} confidence` : `${c.detection.confidence} confidence` });
  rows.push({ label: 'Reports', value: reports.length ? '' : 'Nothing yet', chips: reports });
  if (c.runtime) rows.push({ label: 'Replies recorded as', value: replies ? RECORDED[replies.basis] ?? replies.basis : `None · ${rtName(c)} doesn’t report them` });
  return { key: 'runtime', title: 'Runtime', right: s.status.reason === 'sleeping' ? 'Asleep' : STATE_WORD[s.status.state], tip: null, blocks: [{ kind: 'kv', rows }] };
};
const memoryCard = (s: SnapshotV2): ServerCard | null => {
  const m = s.runtime.memory, held = heldBySource(s);
  if (m.metalBytes != null) return { key: 'memory', title: 'Runtime memory', right: `Splash · ${held ? 'last observed' : 'reported'}`,
    tip: tip('mem', 'Runtime memory', ['Splash’s own Metal allocation, kept separate from process memory.', 'Live → This Mac compares it with the macOS GPU wired limit.']),
    blocks: [{ kind: 'values', cols: 2, items: [{ label: 'Metal memory', value: v(size(m.metalBytes)) }, ...m.metalPeakBytes != null ? [{ label: 'Metal peak', value: v(size(m.metalPeakBytes)) }] : []] }] };
  if (m.modelBytes == null && m.processBytes == null) return null;
  const items = [...m.modelBytes != null ? [{ label: 'Model memory', value: v(size(m.modelBytes)) }] : [],
    ...m.ceilingBytes != null ? [{ label: 'Engine-pool ceiling', value: v(size(m.ceilingBytes)) }] : m.processBytes != null ? [{ label: 'Process memory', value: v(size(m.processBytes)) }] : []];
  return { key: 'memory', title: 'Runtime memory', right: `${rtName(s.connection)} · reported`,
    tip: tip('mem', 'Runtime memory', [`${rtName(s.connection)}’s model allocation${m.ceilingBytes != null ? ' against its engine-pool ceiling' : ''}, as it reports them. Not per-chat memory.`,
      'The process footprint and the macOS GPU wired limit are on Live → This Mac.']),
    blocks: [{ kind: 'values', cols: 2, items }, ...m.modelBytes != null && m.ceilingBytes ? [{ kind: 'meter' as const, fraction: Math.min(1, m.modelBytes / m.ceilingBytes) }] : []] };
};
const cacheCard = (s: SnapshotV2): ServerCard | null => {
  const request = s.runtime.request, c = s.runtime.server.cache;
  if (!c) return null;
  const reuse = request?.promptTokens && request.cachedTokens != null ? request : null;
  const cacheItems = [...c.ramBytes != null ? [{ label: 'RAM cache', value: v(size(c.ramBytes)), small: c.ramEntries != null ? `${int(c.ramEntries)} entries` : undefined }] : [],
    ...c.ssdBytes != null ? [{ label: 'SSD cache', value: v(size(c.ssdBytes)), small: c.ssdEntries != null ? `${int(c.ssdEntries)} entries` : undefined }] : []];
  return { key: 'cache', title: 'Cache & input', right: reuse ? 'Current request' : 'Server cache',
    tip: tip('cache', 'Cache & input', ['Reused and not-reused tokens are the runtime’s counts for the current request.', 'Unreused input is not necessarily the size of a prefill stage.']),
    blocks: [...reuse ? [{ kind: 'values' as const, cols: 2 as const, big: true, items: [{ label: 'Reused tokens', value: v(int(reuse.cachedTokens!)) },
      { label: 'Not reused', value: v(int(reuse.promptTokens! - reuse.cachedTokens!)) }] }, { kind: 'bar' as const, fraction: reuse.cachedTokens! / reuse.promptTokens! }] : [],
    ...cacheItems.length ? [{ kind: 'values' as const, cols: 2 as const, items: cacheItems }] : []] };
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
    tip: tip('resident', title, source === 'ollama-ps' ? ['Ollama reports residency only: how much of each model it holds on the GPU.', 'Apple silicon shares one memory pool, so GPU-resident is not a separate memory.']
      : source === 'lms-ps' ? ['From LM Studio’s command line with the no-wake server path, so it never starts Bionic.', 'Context sizes and formats are in the model inventory below.']
        : ['Models the runtime reports as loaded. Not assigned to a chat.', !many && 'With one model loaded, its memory is the Runtime memory figure.']),
    blocks: [{ kind: 'list', items }] };
};
const sessionCard = (s: SnapshotV2, now: number): ServerCard | null => {
  const a = s.runtime.server.averages;
  if (!a) return null;
  const held = heldBySource(s), basis = held ? 'last-observed' as const : 'reported' as const;
  const since = held && s.status.sinceAt ? `before ${clock(s.status.sinceAt, now)}` : a.uptimeMs ? `${dur(a.uptimeMs)} · since start`
    : s.connection.runtime === 'lmstudio' ? 'Since the log stream started' : 'Since the runtime started';
  const items = [...a.decodeTps != null ? [{ label: 'Decode average', value: v(`${tps(a.decodeTps)} tok/s`, basis) }] : [],
    ...a.prefillTps != null ? [{ label: 'Prefill average', value: v(`${tps(a.prefillTps)} tok/s`, basis) }] : [],
    ...a.cacheEfficiencyFraction != null ? [{ label: 'Cache efficiency', value: v(pct(a.cacheEfficiencyFraction), basis) }] : [],
    ...a.requestsTotal != null ? [{ label: 'Completed', value: v(int(a.requestsTotal), basis), small: a.failedTotal ? `${int(a.failedTotal)} failed` : undefined }] : []];
  return items.length ? { key: 'session', title: 'Server session', right: since, blocks: [{ kind: 'values', cols: 2, items }],
    tip: tip('session', 'Server session', ['Across all models and apps that used this runtime, as the runtime reports them.']) } : null;
};
const latencyCard = (s: SnapshotV2): ServerCard | null => {
  const h = s.runtime.server.histograms;
  if (!h || !h.ttftMs && !h.itlMs) return null;
  const q = (label: string, x: NonNullable<typeof h.ttftMs>) => ({ label: `${label} p50 · p95`, value: v(`${dur(x.p50)} · ${dur(x.p95)}`), small: `n ${int(x.n)}` });
  return { key: 'latency', title: 'Latency', right: heldBySource(s) ? 'Splash native · last observed' : 'Splash native',
    tip: tip('latency', 'Latency', ['Splash’s own percentiles over its last 4,096 samples, across all clients.', 'Splash reports p95; Scope’s own baselines use p90.']),
    blocks: [{ kind: 'values', cols: 2, items: [...h.ttftMs ? [q('TTFT', h.ttftMs)] : [], ...h.itlMs ? [q('Between tokens', h.itlMs)] : []] }] };
};
const slotsCard = (s: SnapshotV2): ServerCard | null => {
  const slots = s.runtime.slots;
  if (!slots.length) return null;
  const busy = slots.filter(slot => slot.busy).length;
  return { key: 'slots', title: 'Slots', right: `${busy} of ${slots.length} busy`,
    tip: tip('slots', 'Slots', ['Numbers only: Scope never reads prompts from /slots.', 'It polls /slots only while /metrics shows work, so a sleeping server stays asleep.']),
    blocks: [{ kind: 'list', items: slots.map(slot => ({ title: `Slot ${slot.id}`, loaded: false, meter: null,
      chips: [{ text: slot.busy ? 'Busy' : 'Idle', ...slot.busy ? { tone: 'accent' as const } : {} }],
      reading: [slot.busy ? [slot.decodedTokens != null && `${int(slot.decodedTokens)} decoded`, slot.promptTokens != null && `${kt(slot.promptTokens)} prompt`].filter(Boolean).join(' · ') || 'Busy' : 'Waiting',
        `${kt(slot.contextWindowTokens)} context`] })) }] };
};
const ratesCard = (s: SnapshotV2): ServerCard | null => {
  const r = s.runtime.server.rates, server = s.runtime.server;
  if (!r) return null;
  return { key: 'rates', title: 'Server throughput', right: `last ${Math.round(r.windowMs / 1_000)} s`,
    tip: tip('rates', 'Server throughput', [`Worked out from ${rtName(s.connection)}’s running totals, never its windowed gauges (every scrape resets those).`]),
    blocks: [{ kind: 'values', cols: 3, items: [...r.promptTps != null ? [{ label: 'Prompt', value: v(`${int(r.promptTps)} tok/s`, 'derived') }] : [],
      ...r.decodeTps != null ? [{ label: 'Decode', value: v(`${tps(r.decodeTps)} tok/s`, 'derived') }] : [],
      ...server.active != null ? [{ label: 'Processing · deferred', value: v(`${server.active} · ${server.queued ?? 0}`) }] : []] }] };
};
const specCard = (s: SnapshotV2): ServerCard | null => {
  const sp = s.runtime.server.speculative;
  if (!sp) return null;
  return { key: 'spec', title: 'Speculative decoding', right: `last ${Math.max(1, Math.round(sp.windowMs / 60_000))} min`,
    tip: tip('spec', 'Speculative decoding', ['Server-wide, from llama-server’s counters.', 'Higher acceptance means the draft model guesses more tokens that the main model keeps.']),
    blocks: [{ kind: 'values', cols: 2, items: [{ label: 'Draft acceptance', value: v(pct(sp.acceptanceFraction), 'derived') },
      { label: 'Accepted', value: v(`${int(sp.acceptedTokens)} of ${int(sp.draftedTokens)}`) }] }, { kind: 'meter', fraction: sp.acceptanceFraction }] };
};
const enginesCard = (s: SnapshotV2): ServerCard | null => {
  const engines = s.runtime.engines;
  if (!engines.length) return null;
  return { key: 'engines', title: 'Engines', right: 'lms runtime ls · cached 10 min',
    tip: tip('engines', 'Engines', ['Read only while this tab is visible. Scope never installs, selects or updates engines.']),
    blocks: [{ kind: 'list', items: engines.map(engine => ({ title: `${engine.name} ${engine.version}`, loaded: false, reading: [], meter: null,
      chips: [{ text: engine.selected ? 'In use' : 'Installed', ...engine.selected ? { tone: 'accent' as const } : {} }] })) }] };
};
const catalogCard = (s: SnapshotV2): ServerCard | null => {
  const catalog = s.runtime.catalog;
  if (!catalog.length) return null;
  return { key: 'catalog', title: 'Model inventory', right: `${catalog.filter(model => model.loaded).length} loaded · ${catalog.length} listed`, tip: null,
    blocks: [{ kind: 'list', chipGroup: true, items: catalog.map(model => ({ title: model.name, loaded: model.loaded === true, meter: null,
      chips: [...model.format ? [{ text: model.format, ...model.format === 'splash' ? { tone: 'accent' as const } : {} }] : [],
        ...model.vision ? [{ text: `vision${model.inputModalities?.length ? ` · ${model.inputModalities.join(' + ')}` : ''}` }] : []],
      reading: [model.loaded ? 'Loaded' : model.loaded === false ? 'Available' : 'Listed', ...model.contextWindowTokens ? [`${kt(model.contextWindowTokens)} context`] : []] })) }] };
};

export const presentServer = (snapshot: SnapshotV2 | null, now: number, extra: readonly Callout[] = []): ServerView => {
  if (!snapshot) return { callouts: callouts(null, now, extra), cards: [] };
  const cards = [runtimeCard(snapshot), slotsCard(snapshot), ratesCard(snapshot), specCard(snapshot), latencyCard(snapshot), memoryCard(snapshot),
    cacheCard(snapshot), residencyCard(snapshot, now), enginesCard(snapshot), catalogCard(snapshot), sessionCard(snapshot, now)];
  return { callouts: callouts(snapshot, now, extra), cards: cards.filter((card): card is ServerCard => card !== null) };
};
