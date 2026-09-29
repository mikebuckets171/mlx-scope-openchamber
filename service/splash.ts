import { unavailableTelemetry, type TelemetrySnapshot } from '../src/telemetry.ts';
import type { CatalogModel } from '../src/runtime.ts';
import type { RuntimeRead } from './adapter.ts';
import { count, modelLabel, nonneg, obj, positive } from './lib/parse.ts';

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

    const instance = obj(status.instance);
    const requests = obj(status.requests);
    const metrics = obj(status.metrics);
    const memory = obj(status.memory_actual);
    const modelID = modelLabel(instance?.model);
    const maximumContext = positive(status.maximum_context_tokens);
    const currentBytes = bytesToGB(memory?.current_bytes);
    const rawPeakBytes = bytesToGB(memory?.peak_bytes);
    const peakBytes = currentBytes !== null && rawPeakBytes !== null && rawPeakBytes < currentBytes ? null : rawPeakBytes;
    const catalog: CatalogModel[] = modelID ? [{
      name: modelID,
      loaded: status.ready === true ? true : null,
      format: 'splash',
      contextWindow: maximumContext,
    }] : [];
    const submitted = count(requests?.submitted), completed = count(requests?.completed);
    const failed = count(requests?.failed), cancelled = count(requests?.cancelled) ?? 0;
    const inFlight = submitted === null || completed === null || failed === null ? null
      : Math.max(0, submitted - completed - failed - cancelled);
    const phase = !status.ready ? 'unknown' : inFlight === null ? 'unknown' : inFlight > 0 ? 'processing' : 'idle';

    return {
      ...unavailableTelemetry('unsupported_contract', null, sampledAt),
      available: true,
      reason: null,
      runtime: 'splash',
      phase,
      modelID,
      contextWindow: maximumContext,
      activeRequests: status.ready ? inFlight : null,
      catalog,
      message: !status.ready ? `Loading ${modelID?.split('/').at(-1) ?? 'the model'}…`
        : inFlight === null ? 'Ready.'
        : inFlight > 0 ? `Generating · ${inFlight} ${inFlight === 1 ? 'request' : 'requests'} in flight.` : 'Idle · ready for your next request.',
      serverStats: {
        ready: status.ready,
        aggregateDecodeTokensPerSecond: nonneg(metrics?.decode_tokens_per_second),
        completedRequests: completed,
        failedRequests: failed,
        metalCurrentGB: currentBytes,
        metalPeakGB: peakBytes,
      },
    };
  }
}
