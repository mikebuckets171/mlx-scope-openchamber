import { expect, test } from 'bun:test';
import * as v16 from '../../src/contract/testing/v1-panel.ts';
import { EPOCH, hostStates } from '../../src/contract/testing/v1-states.ts';
import type { V1Snapshot } from '../../src/contract/convert-v1.ts';
import { parseTelemetrySnapshot } from '../../src/telemetry.ts';
import { contextBudget } from '../context.ts';
import { cacheSplit, prefillEstimate } from '../insights.ts';
import { prefillReading } from '../progress.ts';
import { measurementReport } from '../report.ts';
import { observationReport, sanitizeObservation, snapshotObservation, type Observation } from '../saved.ts';
import { completionOf, fromService } from '../testing/readings.ts';
import { savedValue } from './captures.ts';

// Parity oracle: every 1.x state the 1.6 panel can show, read by the 2a panel through the v2 bridge, gives exactly the
// values the frozen 1.6 functions gave from the 1.x body. The goldens cover the DOM; this covers the pure functions
// across the service's real adapters and the whole oMLX corpus.
const NOW = EPOCH + 60_000;
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const states = hostStates();
// Compare the frozen oracle's calculations while allowing the intentional plain-language labels.
const plainReport = (report: string) => report
  .replace('Scope: runtime server / whole host, not a selected chat', 'Scope: all server activity and this Mac')
  .replace('Model context:', 'Model capacity:')
  .replace('tokens to reported limit (not OpenCode compaction or output budget)', 'tokens remaining in the model’s capacity. OpenCode may shorten the conversation sooner')
  .replace('Generation (request average):', 'Generation speed (request average):')
  .replace('Prefill (reported speed):', 'Prefill speed (from server):')
  .replace('Prefill: ', 'Prompt reading left: ')
  .replace('Prefill stage estimate:', 'Estimated time left:')
  .replace('(reported stage estimate, not a completion deadline)', '(server estimate for reading this prompt portion)')
  .replace('Non-free RAM:', 'Memory allocated:')
  .replace('(includes reclaimable pages; not memory pressure)', '(includes memory macOS can reuse)')
  .replace('Splash GPU memory (Metal) · now:', 'Splash GPU memory now:')
  .replace('Splash GPU memory (Metal) · peak:', 'Splash peak GPU memory:')
  .replace('Reading context', 'Reading prompt');
const shown = (item: Observation | null) => item && { report: plainReport(observationReport(item)),
  values: Object.fromEntries(Object.entries(item.measurements).map(([key, value]) => [key, savedValue(key, value)])) };

test('the 2a panel computes what 1.6 computed, for every fixture state', () => {
  expect(states.length).toBeGreaterThan(250);
  for (const state of states) {
    const original = parseTelemetrySnapshot(wire(state.body)), current16 = original.available ? original : null;
    // The service converts its raw reading; a reading the 1.6 panel had already parsed converts the same way.
    for (const [input, route] of [[state.body, 'service body'], [original, 'panel-parsed body']] as const) {
      const reading = fromService(input as V1Snapshot), current = reading.available ? reading : null, name = `${state.name} (${route})`;
      expect(contextBudget(reading), name).toEqual(v16.contextBudget(original));
      expect(prefillReading(current), name).toEqual(v16.prefillReading(current16));
      expect(prefillEstimate(current), name).toBe(v16.prefillEstimate(current16));
      expect(cacheSplit(current?.request?.promptTokens, current?.request?.cachedTokens), name).toEqual(v16.cacheSplit(current16));
      for (const paused of [false, true, 'refreshing'] as const) {
        // Splash's legacy decode value is lifetime; a false ready flag does not establish that loading is underway.
        const report16 = plainReport(v16.measurementReport(original, original.system, paused, 'test', NOW))
          .replace('Splash server decode (all requests):', 'Splash average generation speed since model start (all requests):')
          .replace('Splash ready: no (loading)', 'Splash ready: no');
        expect(measurementReport(reading, reading.host, paused, 'test', NOW, completionOf(reading)), name)
          .toBe(report16);
      }
      for (const held of [false, true]) {
        const saved = sanitizeObservation(snapshotObservation(reading, held, held ? null : 12.345, NOW));
        const frozen = sanitizeObservation(v16.snapshotObservation(original, held, held ? null : 12.345, NOW));
        expect(shown(saved), name).toEqual(shown(frozen));
      }
    }
  }
});
