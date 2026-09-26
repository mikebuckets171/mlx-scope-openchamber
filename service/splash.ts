import { unavailableTelemetry, type TelemetrySnapshot } from '../src/telemetry.ts';
import type { CatalogModel } from '../src/runtime.ts';
import type { RuntimeRead } from './adapter.ts';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as ObjectValue : null;
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = (value: unknown): number | null => {
  const result = number(value);
  return result !== null && Number.isSafeInteger(result) ? result : null;
};
const contextLimit = (value: unknown): number | null => {
  const result = count(value);
  return result !== null && result > 0 ? result : null;
};
const modelName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!clean) return null;
  const label = /^(?:[\\/]|\.{1,2}[\\/]|~[\\/]|file:|[A-Za-z]:[\\/])/.test(clean)
    ? clean.split(/[\\/]/).filter(Boolean).at(-1) : clean;
  return label?.slice(0, 160) || null;
};
const bytesToGB = (value: unknown): number | null => {
  const bytes = count(value);
  return bytes === null ? null : bytes / 1e9;
};

/** Reads only Splash's documented passive /status endpoint. */
export class SplashClient {
  constructor(private readonly read: RuntimeRead, private readonly now: () => number = Date.now) {}

  async snapshot(): Promise<TelemetrySnapshot> {
    const status = await this.read('/status');
    const sampledAt = this.now();
    if (!status || typeof status.ready !== 'boolean') {
      return { ...unavailableTelemetry('unsupported_contract', 'Splash returned an unsupported status response.', sampledAt), runtime: 'splash' };
    }

    const instance = object(status.instance);
    const requests = object(status.requests);
    const metrics = object(status.metrics);
    const memory = object(status.memory_actual);
    const modelID = modelName(instance?.model);
    const maximumContext = contextLimit(status.maximum_context_tokens);
    const currentBytes = bytesToGB(memory?.current_bytes);
    const rawPeakBytes = bytesToGB(memory?.peak_bytes);
    const peakBytes = currentBytes !== null && rawPeakBytes !== null && rawPeakBytes < currentBytes ? null : rawPeakBytes;
    const catalog: CatalogModel[] = modelID ? [{
      name: modelID,
      loaded: status.ready === true ? true : null,
      format: null,
      contextWindow: maximumContext,
    }] : [];

    return {
      ...unavailableTelemetry('unsupported_contract', null, sampledAt),
      available: true,
      reason: null,
      runtime: 'splash',
      phase: 'unknown',
      modelID,
      contextWindow: maximumContext,
      catalog,
      message: status.ready
        ? 'Splash is ready. Decode throughput and request counters are server-wide; per-request activity is unavailable.'
        : 'Splash is reachable, but its runtime reports that it is not ready.',
      serverStats: {
        ready: status.ready,
        aggregateDecodeTokensPerSecond: number(metrics?.decode_tokens_per_second),
        completedRequests: count(requests?.completed),
        failedRequests: count(requests?.failed),
        metalCurrentGB: currentBytes,
        metalPeakGB: peakBytes,
      },
    };
  }
}
