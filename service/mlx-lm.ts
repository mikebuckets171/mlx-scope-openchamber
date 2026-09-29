import { unavailableTelemetry, type TelemetrySnapshot } from '../src/telemetry.ts';
import type { CatalogModel } from '../src/runtime.ts';
import type { RuntimeRead } from './adapter.ts';
import { modelLabel, obj } from './lib/parse.ts';

/** The official server exposes availability and a disk catalogue, not live inference readings. */
export class MlxLmClient {
  private catalog: CatalogModel[] = [];
  private catalogAt = Number.NEGATIVE_INFINITY;
  private catalogAvailable = false;

  constructor(private readonly read: RuntimeRead, private readonly now: () => number = Date.now) {}

  async snapshot(): Promise<TelemetrySnapshot> {
    const health = await this.read('/health');
    const sampledAt = this.now();
    if (health?.status !== 'ok') {
      return unavailableTelemetry('runtime_unreachable', 'The mlx-lm server is unavailable.', sampledAt);
    }
    // /v1/models scans the Hugging Face cache; never repeat that scan at live cadence.
    if (sampledAt < this.catalogAt || sampledAt - this.catalogAt >= 60_000) {
      this.catalog = [];
      this.catalogAvailable = false;
      const response = await this.read('/v1/models');
      this.catalogAt = sampledAt;
      if (response?.object === 'list' && Array.isArray(response.data)) {
        this.catalogAvailable = true;
        this.catalog = response.data.slice(0, 12).flatMap(raw => {
          const name = modelLabel(obj(raw)?.id);
          return name ? [{ name, loaded: null, format: 'mlx' as const, contextWindow: null }] : [];
        });
      }
    }
    return {
      ...unavailableTelemetry('unsupported_contract', null, sampledAt),
      available: true, reason: null, runtime: 'mlx-lm', phase: 'unknown',
      message: this.catalogAvailable
        ? 'Server reachable · mlx-lm does not expose live progress, speed or model residency.'
        : 'Server reachable · model list unavailable. mlx-lm does not expose live inference readings.',
      catalog: this.catalog.map(model => ({ ...model })),
    };
  }
}
