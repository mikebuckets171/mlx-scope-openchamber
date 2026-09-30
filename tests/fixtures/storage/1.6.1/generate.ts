// Writes observation-v1.json with the v1.6.1 panel's own writer (SavedObservations.save), so the migration golden is a
// record 1.6.1 wrote, not a hand-made one. Run from an extracted v1.6.1 tree (see SOURCE.md); the inputs are synthetic.
import { writeFileSync } from 'node:fs';
import { PerformanceCapture } from './panel/capture.ts';
import { captureObservation, SavedObservations, snapshotObservation } from './panel/saved.ts';
import { parseTelemetrySnapshot, type AvailableTelemetry } from './src/telemetry.ts';

const T0 = 1_790_600_000_000;
const values = new Map<string, unknown>();
const storage = { keys: async () => [...values.keys()].sort(), get: async (key: string) => values.get(key),
  set: async (key: string, value: unknown) => { values.set(key, JSON.parse(JSON.stringify(value))); },
  delete: async (key: string) => { values.delete(key); } };
const system = (at: number, cpu: number, used: number, swap: number) => ({ platform: 'macOS', cpuPercent: cpu, sampledAt: at,
  memoryTotalGB: 51.539607552, memoryUsedGB: used, macOS: { swapUsedGB: swap, sampledAt: at } });
const decode = (at: number, tokens: number) => parseTelemetrySnapshot({ available: true, runtime: 'omlx', phase: 'decode', sampledAt: at,
  modelID: 'Example-27B-4bit', activeRequests: 1, queuedRequests: 0, traceEpoch: 7, completionTokens: tokens, liveDecodeTPS: 24.6,
  memory: { activeGB: 17.179869184 }, system: system(at, 18.5, 30.064771072, 1.073741824) }) as AvailableTelemetry;
const record = (tps: number) => {
  let clock = 0;
  const capture = new PerformanceCapture(() => clock);
  capture.start(decode(T0, 100), 30);
  for (let s = 1; s <= 31; s++) { clock = s * 1000; capture.observe(decode(T0 + s * 1000, 100 + Math.round(s * tps))); }
  return capture.current!;
};
const saved = new SavedObservations(storage as never);
await saved.save(snapshotObservation(parseTelemetrySnapshot({ available: true, runtime: 'omlx', phase: 'prefill', sampledAt: T0 + 60_000,
  modelID: 'Example-27B-4bit', activeRequests: 1, queuedRequests: 1, prefillProgress: 0.625, prefillProcessedTokens: 20_480,
  prefillTotalTokens: 32_768, prefillETASeconds: 12.5, memory: { activeGB: 17.179869184 },
  system: system(T0 + 60_000, 22.25, 32.212254720, 2.147483648) }), false, null, T0 + 61_000));
await saved.save(snapshotObservation(parseTelemetrySnapshot({ available: true, runtime: 'splash', phase: 'unknown', sampledAt: T0 + 120_000,
  modelID: 'Example-35B-A3B-4bit', serverStats: { ready: true, aggregateDecodeTokensPerSecond: 61.3, completedRequests: 17, failedRequests: 1,
    metalCurrentGB: 12.5, metalPeakGB: 13 }, system: system(T0 + 120_000, 9.75, 28.991029248, 0) }), true, 58.2, T0 + 121_000));
await saved.save(captureObservation(record(25), record(22), T0 + 180_000));
writeFileSync(new URL('./observation-v1.json', `file://${process.cwd()}/`), `${JSON.stringify(Object.fromEntries(values), null, 2)}\n`);
