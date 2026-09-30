import { capabilitiesOf } from '../../src/contract/capabilities.ts';
import type { CatalogV2, RuntimeV2, StatusV2 } from '../../src/contract/snapshot.ts';
import type { AdapterContextV2, AdapterReadingV2, AdapterV2, DescriptorV2, ReadContext } from '../core/adapter-v2.ts';
import { HINTS } from '../core/hints.ts';
import { HttpFailure } from '../http.ts';
import { modelLabel, obj } from '../lib/parse.ts';

// mlx-lm on the v2 contract (rewrite of the 1.6 MlxLmClient). The official server reports reachability and a disk catalogue,
// never live inference. Detection is by hint only. The catalogue is optional: when /v1/models fails, the catalog capability
// is dropped and the runtime stays reachable, except that a rejected key is never hidden behind the anonymous /health.

/** /v1/models scans the Hugging Face cache; never repeat that scan at live cadence. */
export const CATALOG_EVERY_MS = 60_000;
const hint = HINTS.find(([id]) => id === 'mlx-lm')![1];
const runtime = (catalog: CatalogV2[]): RuntimeV2 => ({ phase: 'unknown', request: null, server: { active: null, queued: null }, memory: {},
  residency: [], slots: [], catalog, engines: [] });

class MlxLmAdapter implements AdapterV2 {
  private catalog: CatalogV2[] | null = null;
  private catalogAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly context: AdapterContextV2) {}

  async identity(): Promise<boolean> {
    const reply = await this.context.get('/health');
    return reply.status === 200 && reply.body?.status === 'ok';
  }

  dispose(): void { this.catalog = null; }

  async read(_context: ReadContext): Promise<AdapterReadingV2> {
    const health = await this.context.get('/health'), at = this.context.now();
    const reading = (status: StatusV2, catalog: CatalogV2[] | null): AdapterReadingV2 => ({ at, status, identity: {}, completions: [],
      capabilities: capabilitiesOf(catalog ? [{ key: 'server.catalog', basis: 'reported' }] : []), runtime: runtime(catalog ?? []) });
    if (health.status === 401 || health.status === 403) return reading({ state: 'failing', reason: 'authentication_failed', params: {} }, null);
    if (health.status === 404 || health.status === 405 || health.routeMissing) return reading({ state: 'degraded', reason: 'unsupported_contract', params: {} }, null);
    if (health.status !== 200 || health.body?.status !== 'ok') throw new HttpFailure('runtime_unreachable', 'The mlx-lm server is unavailable.', health.status);
    if (at < this.catalogAt || at - this.catalogAt >= CATALOG_EVERY_MS) {
      this.catalogAt = at;
      let reply;
      try { reply = await this.context.get('/v1/models'); } catch { reply = null; }
      if (reply?.status === 401 || reply?.status === 403) {
        this.catalogAt = Number.NEGATIVE_INFINITY;
        return reading({ state: 'failing', reason: 'authentication_failed', params: {} }, null);
      }
      this.catalog = reply?.status === 200 && reply.body?.object === 'list' && Array.isArray(reply.body.data)
        ? reply.body.data.slice(0, 12).flatMap(raw => {
          const name = modelLabel(obj(raw)?.id);
          return name ? [{ name, loaded: null, format: 'mlx' as const, contextWindowTokens: null }] : [];
        }) : null;
    }
    return reading({ state: 'ready', reason: null, params: {} }, this.catalog && this.catalog.map(model => ({ ...model })));
  }
}

export const mlxLmDescriptor: DescriptorV2 = {
  id: 'mlx-lm', hints: hint, detect: [], identityEveryMs: 60_000,
  capabilities: [{ key: 'server.catalog', basis: 'reported' }],
  cadence: () => 2_000,
  create: context => new MlxLmAdapter(context),
};
