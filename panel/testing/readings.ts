// Test support only: 1.x fixture bodies as the 2a panel reads them, through the real converter, wire and v2 parser.
import type { CompletionV2 } from '../../src/contract/completion.ts';
import { toSnapshotV2, type V1Snapshot } from '../../src/contract/convert-v1.ts';
import { parseSnapshotV2, type SnapshotV2 } from '../../src/contract/snapshot.ts';
import { parseTelemetrySnapshot } from '../../src/telemetry.ts';
import { legacyFromSnapshot as fromSnapshot, type LegacyReading as Reading } from '../compat/reading.ts';

export const EXTRAS = { service: { version: '2.0.0', instance: '5c1e0a7b' } };
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** The v2 body a converted 1.x reading puts on the wire, as the panel's client validates it. */
export const v2Body = (v1: Record<string, unknown>): SnapshotV2 =>
  parseSnapshotV2(wire(toSnapshotV2(parseTelemetrySnapshot(wire(v1)) as V1Snapshot, EXTRAS)))!;
/**
 * A 1.x fixture as the panel reads it. The 2.0 wire has no `traceEpoch` or `sessionStatsState` (the 2a compat bridge is gone:
 * the panel takes continuity from `connection.generation` and freshness from the status); 1.6 module tests that pin
 * request-boundary logic keep their 1.x inputs through this helper.
 */
export const fromV1 = (v1: Record<string, unknown>): Reading => {
  const reading = fromSnapshot(v2Body(v1));
  if (!reading.available) return reading;
  const stats = v1.sessionStatsState;
  return { ...reading, traceEpoch: typeof v1.traceEpoch === 'number' ? v1.traceEpoch : v1.traceEpoch === null ? null : reading.traceEpoch,
    statsState: stats === 'fresh' || stats === 'stale' || stats === 'unavailable' ? stats : reading.statsState };
};
/** A service's raw 1.x body converted as the service (and the synthetic host) converts it, without the 1.6 panel parser. */
export const fromService = (v1: V1Snapshot): Reading => fromSnapshot(parseSnapshotV2(wire(toSnapshotV2(wire(v1), EXTRAS)))!);
/** The newest completion a reading carried, as the panel's state keeps it. */
export const completionOf = (reading: Reading): CompletionV2 | null => reading.available ? reading.body?.completions.items.at(-1) ?? null : null;
