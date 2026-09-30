import { v1Parts } from '../../src/contract/convert-v1.ts';
import { unavailableTelemetry, type TelemetrySnapshot } from '../../src/telemetry.ts';
import type { RuntimeRead } from '../adapter.ts';
import { HttpFailure } from '../http.ts';
import { LMStudioClient } from '../lmstudio.ts';
import type { ActivitySource } from '../lmstudio-activity.ts';
import { isOmlxHealth, OmlxClient } from '../omlx-client.ts';
import { SplashClient } from '../splash.ts';
import type { AdapterContextV2, AdapterReadingV2, AdapterV2, CompletionDraft, DescriptorV2, ReadContext, RuntimeGet, RuntimeReply } from './adapter-v2.ts';
import { HINTS } from './hints.ts';

// Stage 2b bridge: the 1.6 oMLX, LM Studio and Splash clients behind the v2 adapter contract, until the ad-omlx, ad-lmstudio
// and ad-splash tracks replace these descriptors in `descriptorsWith` (service/core/registry.ts). Readings go through
// convert-v1's parser, so what 2a withheld stays withheld; the 1.6 English is dropped (codes only), and an unsupported
// reading is degraded rather than failing, so three in a row start re-detection.

type Legacy = { snapshot(deadline?: number): Promise<TelemetrySnapshot> };
/** What only the service can give a bridged adapter: the process-wide LM Studio log stream, per port. */
export interface LegacyExtras { activity: (port: number) => ActivitySource | null }

const hint = (id: string) => HINTS.find(([runtime]) => runtime === id)![1];
/** 1.6's reader: any status but 200 (or a loading /health) throws the way requestJSON did. */
const legacyRead = (get: RuntimeGet): RuntimeRead => async path => {
  const reply = await get(path);
  if (reply.status === 401 || reply.status === 403) throw new HttpFailure('authentication_failed', 'The runtime rejected the request.', reply.status);
  if (reply.status !== 200 && !(path === '/health' && reply.status === 503)) throw new HttpFailure('runtime_unreachable', `The runtime returned HTTP ${reply.status}.`, reply.status);
  if (reply.body === null) throw new HttpFailure('runtime_unreachable', 'The runtime returned invalid JSON.');
  return reply.body;
};

class LegacyAdapter implements AdapterV2 {
  private last: string | null = null;
  constructor(private readonly client: Legacy, private readonly check: () => Promise<boolean>, private readonly now: () => number) {}
  identity(): Promise<boolean> { return this.check(); }
  dispose(): void {}
  async read(context: ReadContext): Promise<AdapterReadingV2> {
    let v1: TelemetrySnapshot;
    try { v1 = await this.client.snapshot(context.deadline); } catch (error) {
      // A route this runtime should have is missing: something else answers on the port.
      if (error instanceof HttpFailure && (error.status === 404 || error.status === 405)) v1 = unavailableTelemetry('unsupported_contract', null, this.now());
      else throw error;
    }
    const parts = v1Parts(v1);
    const status = parts.status.reason === 'unsupported_contract' ? { state: 'degraded' as const, reason: 'unsupported_contract' as const, params: {} }
      : { state: parts.status.state, reason: parts.status.reason, params: {} };
    // One draft per distinct finished request; the 1.x reading repeats its last request on every poll.
    const key = parts.last && JSON.stringify([parts.last.finishedAt, parts.last.model, parts.last.outputTokens, parts.last.promptTokens]);
    const completions: CompletionDraft[] = parts.last && key !== this.last ? [parts.last] : [];
    if (key) this.last = key;
    return { at: parts.runtime.sampledAt ?? v1.sampledAt, status, capabilities: parts.capabilities, runtime: parts.runtime, identity: {}, completions, compat: parts.compat };
  }
}

const reply = async (get: RuntimeGet, path: string): Promise<RuntimeReply | null> => { try { return await get(path); } catch { return null; } };
const isLMStudioModels = ({ status, body }: RuntimeReply): boolean => status === 200 && Array.isArray(body?.models);
const isSplashStatus = ({ status, body }: RuntimeReply): boolean => status === 200 && typeof body?.ready === 'boolean';

export const legacyOmlx: DescriptorV2 = {
  id: 'omlx', hints: hint('omlx'), identityEveryMs: 300_000, capabilities: [], cadence: () => 450,
  detect: [{ probe: '/health', confidence: 'high', match: ({ status, body }) => isOmlxHealth(body, status) }],
  create: (context: AdapterContextV2) => new LegacyAdapter(new OmlxClient({ fetchImpl: context.fetchImpl, readConfig: async () => context.config,
    now: context.now, monotonicNow: context.monotonic, requestTimeoutMs: context.timeoutMs, collectionDeadlineMs: context.budgetMs }),
  async () => { const health = await context.get('/health'); return isOmlxHealth(health.body, health.status); }, context.now),
};

/** LM Studio family: the `{"lmstudio":true}` greeting, or (older builds without it) the 1.6 `/api/v1/models` inventory. */
export const legacyLMStudio = (extras: LegacyExtras): DescriptorV2 => ({
  id: 'lmstudio', hints: hint('lmstudio'), identityEveryMs: 60_000, capabilities: [],
  cadence: ({ activity }) => activity ? 1_000 : 5_000,
  detect: [
    { probe: '/lmstudio-greeting', confidence: 'high', match: ({ status, body }) => status === 200 && body?.lmstudio === true },
    { probe: '/lmstudio-greeting', confidence: 'medium', match: async (greeting, follow) =>
      (greeting.status === 404 || greeting.routeMissing) && isLMStudioModels(await follow('/api/v1/models')) },
  ],
  create: context => new LegacyAdapter(new LMStudioClient(legacyRead(context.get), context.now, extras.activity(context.connection.port)), async () => {
    const greeting = await context.get('/lmstudio-greeting');
    if (greeting.status === 200 && greeting.body?.lmstudio === true) return true;
    const models = await reply(context.get, '/api/v1/models');
    if (models && isLMStudioModels(models)) return true;
    const legacy = models?.routeMissing ? await reply(context.get, '/api/v0/models') : null;
    return legacy?.status === 200 && legacy.body?.object === 'list';
  }, context.now),
});

export const legacySplash: DescriptorV2 = {
  id: 'splash', hints: hint('splash'), identityEveryMs: 60_000, capabilities: [], cadence: () => 2_000,
  detect: [{ probe: '/status', confidence: 'medium', match: isSplashStatus }],
  create: context => new LegacyAdapter(new SplashClient(legacyRead(context.get), context.now), async () => isSplashStatus(await context.get('/status')), context.now),
};
