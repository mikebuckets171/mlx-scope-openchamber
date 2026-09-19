import { expect, test } from 'bun:test';
import { parse } from 'jsonc-parser/lib/esm/main.js';
import { normalizeOmlxTelemetry } from './telemetry.ts';
import { contextBudget } from '../panel/context.ts';
import { cacheSplit } from '../panel/insights.ts';
import corpus from '../tests/fixtures/omlx-monitoring.json';
import configurations from '../tests/fixtures/jsonc.json';

for (const fixture of corpus.cases) test(`oMLX contract: ${fixture.name}`, () => {
  const input = fixture as {name: string; activity: unknown; stats?: unknown; contextWindows?: Record<string, number>; invalid?: boolean; expected?: Record<string, unknown>};
  const reading = normalizeOmlxTelemetry(input.stats ?? null, input.activity, new Map(Object.entries(input.contextWindows ?? {})));
  if (input.invalid) { expect(reading).toBeNull(); return; }
  expect(reading).not.toBeNull();
  const actual: Record<string, unknown> = {phase: reading!.phase, active: reading!.activeRequests, queued: reading!.queuedRequests,
    rate: reading!.liveDecodeTPS ?? reading!.livePrefillTPS, prompt: reading!.promptTokens, reused: reading!.cachedTokens,
    output: reading!.completionTokens, progress: reading!.prefillProgress, eta: reading!.prefillETASeconds,
    contextRemaining: contextBudget(reading!)?.remaining ?? null, inputReusedPercent: cacheSplit(reading!)?.percent ?? null};
  for (const [key, value] of Object.entries(input.expected!)) expect(actual[key], `${fixture.name}: ${key}`).toEqual(value);
  expect(JSON.stringify(reading)).not.toContain('synthetic-a');
});
for (const fixture of configurations) test(`JSONC contract: ${fixture.name}`, () => {
  const errors: import('jsonc-parser/lib/esm/main.js').ParseError[] = [];
  const value = parse(fixture.text, errors, {allowTrailingComma: true});
  const valid = !errors.length && value !== null && typeof value === 'object' && !Array.isArray(value);
  expect(valid).toBe(fixture.valid);
});
