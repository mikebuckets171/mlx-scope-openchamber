import { homedir } from 'node:os';
import { capabilitiesOf, type Basis, type CapabilityDescriptor, type CapabilityKey } from '../../src/contract/capabilities.ts';
import { bool, defined, opt } from '../../src/contract/guards.ts';
import { hash32 } from '../../src/contract/hash.ts';
import { LIMITS, type CatalogV2, type Phase, type ResidencyV2, type RuntimeV2, type StatusV2 } from '../../src/contract/snapshot.ts';
import type {
  AdapterContextV2, AdapterReadingV2, AdapterV2, CompletionDraft, DescriptorV2, ReadContext, RuntimeGet, RuntimeReply,
} from '../core/adapter-v2.ts';
import { HINTS } from '../core/hints.ts';
import { HttpFailure } from '../http.ts';
import { isRouteMissingBody } from '../lib/http-text.ts';
import { obj, positive } from '../lib/parse.ts';
import { createConnectionActivity, type ActivityView, type ConnectionActivity } from './lmstudio-activity.ts';
import {
  createLmsCli, createLmsExec, findLms, lmsModelName, readLmsPorts, serverInfoPathOf, type LmsCli, type LmsPorts,
} from './lmstudio-cli.ts';

// Owner: ad-lmstudio. LM Studio / Bionic per connection: /lmstudio-greeting liveness (no spawn), /api/v0/models state as
// the generation key, v0 fallback on a 200 route-missing body, lms only after a greeting within 10 s.

/** lms runs only within this long of a `{"lmstudio":true}` greeting, so it can never be the thing that starts the app (P1). */
export const GREETING_WINDOW_MS = 10_000;
const GREETING_EVERY_MS = 5_000;
/** The local app's recorded ports are re-read at most this often. */
const PORTS_EVERY_MS = 10_000;

const R: Basis = 'reported', O: Basis = 'observed', D: Basis = 'derived';
/**
 * The most an LM Studio connection reports. Counts and elapsed time are Scope's tally of the log stream (observed);
 * averages are computed from the runtime's per-request summaries (derived); completions exist only where the Splash
 * engine prints its `Done ·` summary (Bionic), and are then the runtime's own figures.
 */
export const LMSTUDIO_CAPABILITIES: readonly CapabilityDescriptor[] = [
  { key: 'request.prefillProgress', basis: R }, { key: 'request.elapsed', basis: O }, { key: 'request.context', basis: R },
  { key: 'server.requests', basis: O }, { key: 'server.averages', basis: D }, { key: 'server.residency', basis: R },
  { key: 'server.catalog', basis: R }, { key: 'server.engines', basis: R }, { key: 'server.completions', basis: R },
];

/** A 200 `{"lmstudio":true}`: what lms itself requires before it talks to a server. */
export const isGreeting = (reply: RuntimeReply | null): boolean => reply?.status === 200 && obj(reply.body)?.lmstudio === true;
/** One GET as a reply: an HTTP status thrown by the transport becomes a status; network failures still throw. */
const settle = async (work: Promise<RuntimeReply>): Promise<RuntimeReply> => {
  try {
    const reply = await work;
    return { ...reply, routeMissing: reply.routeMissing || reply.status === 200 && isRouteMissingBody(reply.body) };
  } catch (error) {
    if (error instanceof HttpFailure && error.status !== null) return { status: error.status, body: null, routeMissing: false };
    throw error;
  }
};
const missing = (reply: RuntimeReply): boolean => reply.status === 404 || reply.routeMissing;
const unauthorized = (reply: RuntimeReply): boolean => reply.status === 401 || reply.status === 403;

/** An opaque key over the /api/v0/models load states; a change triggers `lms ps`. Never on the wire. */
export const modelsGenerationKey = (body: unknown): string | null => {
  const item = obj(body);
  if (!item || item.object !== 'list' || !Array.isArray(item.data)) return null;
  const states = item.data.map(raw => { const row = obj(raw); return `${String(row?.id)}\u0000${String(row?.state)}`; }).sort();
  return `v0.${states.length}.${hash32(states.join('\u0001')).toString(16)}`;
};

interface Loaded { id: string; key: string; contextWindowTokens: number | null }
/** The REST inventory as the adapter uses it. `countKnown` is false when any row or instance could not be read. */
export interface LmstudioInventory { catalog: CatalogV2[]; loaded: Loaded[]; loading: string[]; countKnown: boolean; splash: boolean }
const FORMATS = ['mlx', 'gguf', 'splash'] as const;
const format = (value: unknown): CatalogV2['format'] => FORMATS.find(item => item === value) ?? null;
const inventoryOf = (catalog: CatalogV2[], loaded: Loaded[], loading: string[], countKnown: boolean): LmstudioInventory =>
  ({ catalog, loaded, loading, countKnown, splash: catalog.some(model => model.format === 'splash') });

/** `GET /api/v1/models` (LM Studio 0.4+, Bionic). Null when the body is not that inventory. */
export const parseV1Models = (body: unknown): LmstudioInventory | null => {
  const rows = obj(body)?.models;
  if (!Array.isArray(rows)) return null;
  const catalog: CatalogV2[] = [], loaded: Loaded[] = [];
  let countKnown = true;
  for (const raw of rows) {
    const item = obj(raw), key = lmsModelName(item?.key);
    if (!item || !key || item.type !== 'llm' && item.type !== 'embedding') { countKnown = false; continue; }
    const instances = Array.isArray(item.loaded_instances) ? item.loaded_instances : null, contexts = new Set<number | null>();
    let mine = 0;
    if (!instances) countKnown = false;
    for (const rawInstance of instances ?? []) {
      const instance = obj(rawInstance), id = lmsModelName(instance?.id), context = positive(obj(instance?.config)?.context_length);
      if (!id) { countKnown = false; contexts.add(null); continue; }
      loaded.push({ id, key, contextWindowTokens: context });
      contexts.add(context);
      mine += 1;
    }
    const isLoaded = instances === null ? null : mine > 0 ? true : instances.length === 0 ? false : null;
    // A loaded model's window is its instances' shared context; an unloaded one's is its maximum.
    const window = isLoaded === false ? positive(item.max_context_length) : contexts.size === 1 ? [...contexts][0] ?? null : null;
    catalog.push(defined({ name: key, format: format(item.format), loaded: isLoaded, contextWindowTokens: window,
      vision: opt(bool(obj(item.capabilities)?.vision)) }));
  }
  return rows.length > 0 && catalog.length === 0 ? null : inventoryOf(catalog, loaded, [], countKnown);
};

const V0_TYPES = new Set(['llm', 'vlm', 'embeddings']);
/** `GET /api/v0/models`: the pre-0.4 inventory and, everywhere, the per-model load state. Null when not that list. */
export const parseV0Models = (body: unknown): LmstudioInventory | null => {
  const item = obj(body), rows = item?.data;
  if (!Array.isArray(rows) || item?.object !== 'list') return null;
  const catalog: CatalogV2[] = [], loaded: Loaded[] = [], loading: string[] = [];
  let countKnown = true;
  for (const raw of rows) {
    const row = obj(raw), id = lmsModelName(row?.id);
    if (!row || !id || !V0_TYPES.has(String(row.type))) { countKnown = false; continue; }
    const state = row.state === 'loaded' ? true : row.state === 'not-loaded' ? false : null;
    if (state) loaded.push({ id, key: id, contextWindowTokens: null });
    else if (row.state === 'loading') loading.push(id);
    else if (state === null) countKnown = false;
    catalog.push(defined({ name: id, format: format(row.compatibility_type), loaded: state, contextWindowTokens: positive(row.max_context_length),
      vision: row.type === 'vlm' ? true : row.type === 'llm' ? false : undefined }));
  }
  return rows.length > 0 && catalog.length === 0 ? null : inventoryOf(catalog, loaded, loading, countKnown);
};

/** What one read gathered, before it becomes a reading. Pure input to `lmstudioReading`. */
export interface LmstudioSample {
  at: number;
  connectionId: string;
  inventory: LmstudioInventory;
  generationKey: string | null;
  ps: ResidencyV2[] | null;                  // lms ps rows (maybe cached); null when unknown
  engines: EngineRows | null;                // lms runtime ls, only when the Server tab asked
  activity: ActivityView | null;
  lmsBlocked: boolean;                       // lms would serve this connection but the greeting is older than 10 s
}
type EngineRows = RuntimeV2['engines'];

/** Loaded instances first matched to their lms ps row (by instance id, or by key on the v0 inventory), then models mid-load. */
const residencyOf = (sample: LmstudioSample): ResidencyV2[] => {
  const { inventory, ps, activity } = sample, live = activity?.healthy ? activity : null;
  const listed = (item: Loaded) => ps?.find(row => row.model === item.id)
    ?? (item.id === item.key ? ps?.find(row => row.model.startsWith(`${item.key}:`)) : undefined);
  const rows: ResidencyV2[] = inventory.loaded.map(item => {
    const row = listed(item), window = row?.contextWindowTokens ?? item.contextWindowTokens ?? undefined;
    const busy = live?.models.find(model => model.model === item.id);
    // Without a healthy stream the phase is unknown: an lms ps status can be minutes old.
    const phase: Phase = !live ? 'unknown' : !busy ? 'idle' : busy.active > 1 ? 'processing' : busy.phase;
    return defined({ model: item.id, phase, source: row ? 'lms-ps' as const : 'runtime' as const, bytes: row?.bytes, contextWindowTokens: window,
      active: live ? busy?.active ?? 0 : undefined, prefillFraction: busy?.active === 1 && busy.phase === 'prefill' ? opt(busy.fraction) : undefined });
  });
  const resident = new Set(rows.map(row => row.model));
  return [...rows, ...inventory.loading.filter(id => !resident.has(id)).map(model => ({ model, phase: 'loading' as const, source: 'runtime' as const }))];
};

/** One reading from a sample: nothing is filled that its capability does not cover, and nothing is 0 for "unknown". */
export const lmstudioReading = (sample: LmstudioSample): AdapterReadingV2 => {
  const { at, inventory, activity } = sample, live = activity?.healthy ? activity : null;
  const residency = residencyOf(sample);
  const windowOf = (model: string) => residency.find(row => row.model === model)?.contextWindowTokens;
  const loadedCount = inventory.countKnown ? inventory.loaded.length : null;
  const phase: Phase = live && live.active > 1 ? 'processing' : live?.request ? live.request.phase : inventory.loading.length ? 'loading'
    : loadedCount === 0 ? 'not-loaded' : live && loadedCount !== null ? 'idle' : 'unknown';
  const request = live?.request ? defined({ model: live.request.model, elapsedMs: Math.max(0, at - live.request.startedAt),
    prefillFraction: live.request.phase === 'prefill' ? opt(live.request.fraction) : undefined, contextWindowTokens: windowOf(live.request.model) }) : null;
  const averages = activity && Object.keys(activity.averages).length ? activity.averages : undefined;
  const catalog = [...inventory.catalog].sort((a, b) => Number(b.loaded === true) - Number(a.loaded === true)).slice(0, LIMITS.catalog);
  const completions: CompletionDraft[] = activity?.completions ?? [];
  const keys = new Set<CapabilityKey>(['server.catalog', 'server.residency']);
  if (sample.engines) keys.add('server.engines');
  if (averages) keys.add('server.averages');
  if (live) for (const key of ['server.requests', 'request.prefillProgress', 'request.elapsed', 'request.context'] as const) keys.add(key);
  // Stock LM Studio engines print no summary line, so replies are claimed only where one can arrive (or did).
  if (completions.length || live && (inventory.splash || live.seen > 0)) keys.add('server.completions');
  const status: StatusV2 = sample.lmsBlocked ? { state: 'degraded', reason: 'lms_unavailable', params: {} } : { state: 'ready', reason: null, params: {} };
  return {
    at, status, capabilities: capabilitiesOf(LMSTUDIO_CAPABILITIES.filter(({ key }) => keys.has(key))),
    runtime: defined({
      phase, request, server: defined({ active: live ? live.active : null, queued: null, averages }), memory: {},
      residency: residency.slice(0, LIMITS.residency), residencyCount: opt(loadedCount === null ? null : residency.length),
      slots: [], catalog, engines: sample.engines ?? [],
    }),
    identity: defined({ engine: inventory.splash ? 'splash' as const : undefined,
      host: inventory.splash || /bionic/i.test(sample.connectionId) ? 'bionic' as const : undefined }),
    generationKey: sample.generationKey ?? undefined,
    completions,
  };
};

const EMPTY_RUNTIME: RuntimeV2 = { phase: 'unknown', request: null, server: { active: null, queued: null }, memory: {}, residency: [], slots: [], catalog: [], engines: [] };
const unavailable = (at: number, status: StatusV2): AdapterReadingV2 =>
  ({ at, status, capabilities: {}, runtime: structuredClone(EMPTY_RUNTIME), identity: {}, completions: [] });

type InventoryRead = { kind: 'ok'; inventory: LmstudioInventory; key: string | null } | { kind: 'unauthorized' } | { kind: 'unsupported' };
/** Built by `createLmstudioAdapter`; everything that spawns or reads the disk is injected. */
export interface LmstudioDeps {
  home?: string;
  lms?: string | null;                       // default: the first allowlisted lms under HOME
  serverInfoPath?: string;                   // default: <LM Studio home>/.internal/http-server.json
  cli?: LmsCli;
  activity?: ConnectionActivity;
  readPorts?: (serverInfoPath: string) => LmsPorts;
}

class LmstudioAdapter implements AdapterV2 {
  private legacy = false;
  private greetedAt = -Infinity;
  private key: string | null = null;
  private generation = 0;
  private ports: { at: number; value: LmsPorts } | null = null;
  private lastPs: { port: number; rows: ResidencyV2[] } | null = null;

  constructor(private readonly context: AdapterContextV2, private readonly lms: string | null, private readonly cli: LmsCli,
    private readonly activity: ConnectionActivity, private readonly serverInfoPath: string, private readonly readPorts: (file: string) => LmsPorts) {}

  async read({ deadline, tier, detail }: ReadContext): Promise<AdapterReadingV2> {
    const at = this.context.now();
    await this.greet(false);
    const inventory = await this.inventory();
    if (inventory.kind === 'unauthorized') return unavailable(at, { state: 'failing', reason: 'authentication_failed', params: {} });
    if (inventory.kind === 'unsupported') return unavailable(at, { state: 'degraded', reason: 'unsupported_contract', params: {} });
    if (inventory.key !== this.key) { this.key = inventory.key; this.generation += 1; }
    // Only the connection on this Mac's LM Studio REST port may use lms: a tunnel to another app must not get this app's data.
    const ports = this.localPorts(), bound = this.lms !== null && ports.internal !== null && ports.rest === this.context.connection.port;
    const greeted = this.context.monotonic() - this.greetedAt <= GREETING_WINDOW_MS, port = bound && greeted ? ports.internal : null;
    if (port !== null) this.activity.touch(port);
    // lms one-shots only on the full tier (never glance); a glance read reuses the last rows without spawning.
    const [ps, engines] = await Promise.all([
      port !== null && tier === 'full' ? this.bounded(this.cli.ps(port, this.generation), deadline) : Promise.resolve(null),
      port !== null && tier === 'full' && detail ? this.bounded(this.cli.runtimeLs(port), deadline) : Promise.resolve(null)]);
    if (port !== null && ps) this.lastPs = { port, rows: ps };
    return lmstudioReading({ at, connectionId: this.context.connection.id, inventory: inventory.inventory, generationKey: inventory.key,
      ps: port !== null && this.lastPs?.port === port ? this.lastPs.rows : null, engines, activity: this.activity.view(), lmsBlocked: bound && !greeted });
  }

  async identity(): Promise<boolean> { return this.greet(true); }

  dispose(): void { this.activity.dispose(); }

  /** GET /lmstudio-greeting unless one answered in the last 5 s (always for identity). Network failures propagate. */
  private async greet(force: boolean): Promise<boolean> {
    const at = this.context.monotonic();
    if (!force && at - this.greetedAt < GREETING_EVERY_MS && at >= this.greetedAt) return true;
    const ok = isGreeting(await settle(this.context.get('/lmstudio-greeting')));
    if (ok) this.greetedAt = at;
    return ok;
  }

  private localPorts(): LmsPorts {
    const at = this.context.monotonic();
    if (!this.ports || at - this.ports.at >= PORTS_EVERY_MS || at < this.ports.at) this.ports = { at, value: this.readPorts(this.serverInfoPath) };
    return this.ports.value;
  }

  /** A spawn that outlives the read's deadline finishes in the background; its result is cached for the next read. */
  private bounded<T>(work: Promise<T | null>, deadline: number): Promise<T | null> {
    const remaining = Math.min(deadline - this.context.monotonic(), this.context.budgetMs);
    if (remaining <= 0) return Promise.resolve(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), remaining); timer.unref?.(); });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  }

  /** v1 (v0 on hosts without it; a 401 never falls back), plus v0 for the load-state generation key and mid-load states. */
  private async inventory(): Promise<InventoryRead> {
    let v1: LmstudioInventory | null = null;
    if (!this.legacy) {
      const reply = await settle(this.context.get('/api/v1/models'));
      if (unauthorized(reply)) return { kind: 'unauthorized' };
      if (missing(reply)) this.legacy = true;
      else if (reply.status !== 200) throw new HttpFailure('runtime_unreachable', `LM Studio returned HTTP ${reply.status}.`, reply.status);
      else if (!(v1 = parseV1Models(reply.body))) return { kind: 'unsupported' };
    }
    const reply = await settle(this.context.get('/api/v0/models')), v0 = reply.status === 200 && !reply.routeMissing ? parseV0Models(reply.body) : null;
    if (v1) return { kind: 'ok', inventory: { ...v1, loading: v0?.loading ?? [] }, key: v0 ? modelsGenerationKey(reply.body) : instancesKey(v1) };
    if (unauthorized(reply)) return { kind: 'unauthorized' };
    if (v0) return { kind: 'ok', inventory: v0, key: modelsGenerationKey(reply.body) };
    if (reply.status !== 200 && !missing(reply)) throw new HttpFailure('runtime_unreachable', `LM Studio returned HTTP ${reply.status}.`, reply.status);
    return { kind: 'unsupported' };
  }
}
/** Hosts without /api/v0 still get a generation key: the set of loaded instances. */
const instancesKey = (inventory: LmstudioInventory): string =>
  `v1.${hash32(inventory.loaded.map(item => `${item.id}\u0000${item.contextWindowTokens}`).sort().join('\u0001')).toString(16)}`;

/**
 * The adapter for one connection. lms never goes through `context.exec`: native-command.ts cannot pass env, and lms
 * without `LMS_API_SERVER_INFO_PATH` can launch LM Studio. Both spawners here refuse anything `isLmsArgv` rejects.
 */
export const createLmstudioAdapter = (context: AdapterContextV2, deps: LmstudioDeps = {}): AdapterV2 => {
  const home = deps.home ?? homedir(), lms = deps.lms !== undefined ? deps.lms : findLms(home);
  const serverInfoPath = deps.serverInfoPath ?? serverInfoPathOf(home);
  const cli = deps.cli ?? createLmsCli({ exec: createLmsExec(home), lms, serverInfoPath, now: context.now });
  const activity = deps.activity ?? createConnectionActivity({ lms, serverInfoPath, now: context.now, home });
  return new LmstudioAdapter(context, lms, cli, activity, serverInfoPath, deps.readPorts ?? readLmsPorts);
};

/** Detection follow-up: the greeting's server also answers the inventory route (or says it has none, or wants a key). */
const inventoryRoute = async (follow: RuntimeGet): Promise<boolean> => {
  const reply = await settle(follow('/api/v1/models')).catch(() => null);
  return reply !== null && (reply.status === 200 && Array.isArray(obj(reply.body)?.models) || missing(reply) || unauthorized(reply));
};
const hint = HINTS.find(([id]) => id === 'lmstudio')![1];

export const lmstudioDescriptor: DescriptorV2 = {
  id: 'lmstudio', hints: hint,
  detect: [{ probe: '/lmstudio-greeting', confidence: 'high', match: async (reply, follow) => isGreeting(reply) && inventoryRoute(follow) }],
  // The log stream is live; a read only snapshots it, so idle reads can be slower. Status frames poll slower still.
  cadence: ({ activity, tier }) => activity ? 1_000 : tier === 'glance' ? 3_000 : 2_000,
  capabilities: LMSTUDIO_CAPABILITIES, identityEveryMs: 60_000,
  create: context => createLmstudioAdapter(context),
};
