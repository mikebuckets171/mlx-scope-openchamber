import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import { rtName } from './copy.ts';
import { clock, dur, int, pct, size, tps } from './format.ts';
import { modelDisplayName } from './model-name.ts';
import { heldBySource, modelOf, type ScopeInput } from './scope.ts';
import { APPS_HELP, roomGate } from './server.ts';

// Owner: ui-core. 5.5 Engine room (Michael's approved mock, Nov 7): where the engine's memory budget goes, whether another
// chat could start and which apps hold the memory it would need, each request in its lane, and three engine facts.
// Every figure is one the engine or this Mac reported; nothing is estimated here.

export interface EngineSegment { key: string; label: string; bytes: number; fraction: number }
export interface EngineLane { key: string; who: string; mine: boolean; phase: string; tone: 'active' | 'waiting' }
export interface EngineTile { key: string; label: string; value: string; detail: string; fraction?: number }
export interface EngineView {
  title: string;                             // the model, as OpenCode names it
  stamp: string;                             // "Splash · from server" or "Splash · last reading"
  budget: { used: string; limit: string; free: string; segments: EngineSegment[] } | null;
  gate: { open: boolean; text: string; detail: string; denied: string | null } | null;
  apps: { since: string | null; rows: Array<{ name: string; size: string; grew: string | null; fraction: number }>; help: string } | null;
  lanes: { summary: string; rows: EngineLane[] };
  tiles: EngineTile[];
  empty: string | null;                      // why the room has nothing to draw
}

const ACCOUNT_LABELS: Record<string, string> = { experts: 'Experts', fixed: 'Fixed runtime', kv: 'KV cache', states: 'States', hot_kv: 'Hot KV cache',
  kv_staging: 'KV staging', vision_arena: 'Vision', embeddings: 'Embeddings' };
/** The budget's draw order: the biggest, fixed parts first, then what grows with chats. */
const ORDER = ['experts', 'fixed', 'kv', 'hot_kv', 'kv_staging', 'states', 'vision_arena', 'embeddings'];
const accountLabel = (name: string): string => ACCOUNT_LABELS[name] ?? name.replace(/_/g, ' ');
const rank = (name: string): number => { const index = ORDER.indexOf(name); return index < 0 ? ORDER.length : index; };
const waited = (ms: number | undefined): string => ms === undefined ? '' : ` · ${ms < 60_000 ? `${Math.floor(ms / 1_000)} s` : dur(Math.floor(ms / 1_000) * 1_000)}`;

const budgetOf = (room: NonNullable<SnapshotV2['runtime']['memory']['room']>): EngineView['budget'] => {
  const limit = room.limitBytes, accounts = (room.accounts ?? []).filter(account => account.currentBytes > 0);
  if (!limit || !accounts.length) return null;
  const used = accounts.reduce((sum, account) => sum + account.currentBytes, 0), free = Math.max(0, room.headroomBytes ?? limit - used);
  const segments = [...accounts].sort((a, b) => rank(a.name) - rank(b.name) || b.currentBytes - a.currentBytes)
    .map(account => ({ key: account.name, label: accountLabel(account.name), bytes: account.currentBytes, fraction: account.currentBytes / limit }));
  return { used: size(used), limit: size(limit), free: size(free), segments: [...segments, { key: 'free', label: 'Free', bytes: free, fraction: free / limit }] };
};

/**
 * One lane per request the engine reports. This chat's lane comes from its own phase (the chat companion); other
 * requests are counted by the engine and stay anonymous, so nothing is guessed about which chat they belong to.
 */
const lanesOf = (input: ScopeInput, snapshot: SnapshotV2): EngineView['lanes'] => {
  const server = snapshot.runtime.server, gate = server.admission, chat = snapshot.chat;
  const active = server.active ?? 0, memory = gate?.waitingMemory ?? 0, concurrency = gate?.waitingConcurrency ?? 0;
  const queued = Math.max(server.queued ?? 0, memory + concurrency), single = memory + concurrency === 1 ? gate?.oldestWaitMs : undefined;
  const mine = input.chatIsLocal !== false && input.chatActivity === 'busy' && chat ? chat.phase : null;
  const rows: EngineLane[] = [];
  const myWait = mine === 'waiting' && queued > 0;
  if (mine && mine !== 'complete' && mine !== 'cancelled') {
    const phase = myWait ? memory ? `Waiting for memory${waited(single)}` : `Waiting for another chat${waited(single)}`
      : mine === 'generating' || mine === 'reasoning' ? `Generating${chat!.tokensPerSecond ? ` · ${tps(chat!.tokensPerSecond)} tok/s` : ''}`
      : mine === 'tool' ? 'Using tools' : snapshot.runtime.phase === 'prefill' && active === 1 ? 'Reading its prompt' : 'Waiting';
    rows.push({ key: 'mine', who: 'This chat', mine: true, phase, tone: myWait ? 'waiting' : 'active' });
  }
  const mineActive = rows.length && !myWait ? 1 : 0, mineWaiting = myWait ? 1 : 0;
  const working = Math.max(0, active - mineActive), held = Math.max(0, queued - mineWaiting);
  const onlyOne = active === 1 && !mineActive;
  for (let index = 0; index < working; index++) rows.push({ key: `active-${index}`, who: 'Another chat', mine: false, tone: 'active',
    phase: onlyOne ? snapshot.runtime.phase === 'prefill' ? 'Reading its prompt' : snapshot.runtime.phase === 'decode' ? 'Generating' : 'Working' : 'Working' });
  for (let index = 0; index < held; index++) rows.push({ key: `held-${index}`, who: 'Another chat', mine: false, tone: 'waiting',
    phase: memory - mineWaiting > index ? `Waiting for memory${held === 1 ? waited(single) : ''}` : `Waiting for another chat${held === 1 ? waited(single) : ''}` });
  const summary = rows.length ? `${int(rows.filter(row => row.tone === 'active').length)} working · ${held + mineWaiting ? `${int(held + mineWaiting)} waiting` : 'none waiting'}` : 'Idle';
  return { summary, rows };
};

const tilesOf = (snapshot: SnapshotV2): EngineTile[] => {
  const room = snapshot.runtime.memory.room, batches = snapshot.runtime.server.batches, spec = snapshot.runtime.server.speculative, tiles: EngineTile[] = [];
  if (room?.experts) tiles.push({ key: 'experts', label: 'Experts in memory', value: `${int(room.experts.resident)} of ${int(room.experts.total)}`,
    detail: `${pct(room.experts.resident / room.experts.total)} of the model’s experts`, fraction: room.experts.resident / room.experts.total });
  if (batches && batches.single + batches.multi > 0) tiles.push({ key: 'batches', label: 'Decode batches with two or more chats',
    value: `${int(batches.multi)} of ${int(batches.single + batches.multi)}`, detail: `${pct(batches.multi / (batches.single + batches.multi))} since the engine started` });
  if (spec) tiles.push({ key: 'draft', label: 'Draft tokens kept', value: pct(spec.acceptanceFraction),
    detail: `${int(spec.acceptedTokens)} of ${int(spec.draftedTokens)} · last ${Math.max(1, Math.round(spec.windowMs / 60_000))} min` });
  return tiles;
};

export const presentEngine = (input: ScopeInput): EngineView | null => {
  const snapshot = input.snapshot;
  if (!snapshot) return null;
  const room = snapshot.capabilities['server.memory.room'] ? snapshot.runtime.memory.room : undefined;
  const model = modelOf(snapshot), gate = room ? roomGate(room) : null;
  const apps = snapshot.capabilities['host.apps'] ? snapshot.host?.apps : undefined, top = apps?.items[0]?.bytes ?? 0;
  const view: EngineView = {
    title: model ? modelDisplayName(model, snapshot.connection.modelNames, snapshot.connection.id) : rtName(snapshot.connection),
    stamp: `${rtName(snapshot.connection)} · ${heldBySource(snapshot) || !input.fresh ? 'last reading' : 'from server'}`,
    budget: room ? budgetOf(room) : null,
    gate: gate ? { open: gate.open, text: gate.open ? 'Open' : 'Closed', detail: gate.detail,
      denied: room?.deniedReservations ? `It has refused ${int(room.deniedReservations)} memory ${room.deniedReservations === 1 ? 'request' : 'requests'} since it started.` : null } : null,
    apps: apps?.items.length ? { since: apps.sinceAt !== undefined ? clock(apps.sinceAt, input.now) : null, help: APPS_HELP,
      rows: apps.items.slice(0, 5).map(app => ({ name: app.name, size: size(app.bytes), grew: app.grewBytes ? `+${size(app.grewBytes)}` : null, fraction: top ? app.bytes / top : 0 })) } : null,
    lanes: lanesOf(input, snapshot),
    tiles: tilesOf(snapshot),
    empty: null,
  };
  if (!view.budget && !view.gate && !view.tiles.length) view.empty = snapshot.connection.runtime === 'splash'
    ? 'Waiting for Splash’s memory report. The Engine room needs Splash 1.6 or later.'
    : `The Engine room reads Splash’s memory report; ${rtName(snapshot.connection)} doesn’t send one.`;
  return view;
};
