import { expect, test } from 'bun:test';
import corpus from '../tests/fixtures/scope-next-decisions.json';
import { mlxLmDescriptor } from './adapters/mlx-lm.ts';
import { ollamaDescriptor } from './adapters/ollama.ts';
import { vllmMlxDescriptor } from './adapters/vllm-mlx.ts';
import { llamaDescriptor } from './adapters/llama-server.ts';
import { READ, routeContext, type Route } from './adapters/testing.ts';
import { compareRuns } from '../panel/present/run.ts';
import { reply } from '../panel/testing/rows.ts';
import type { Basis } from '../src/contract/capabilities.ts';
import type { RuntimeKind } from '../src/contract/runtime.ts';
import type { SizeBucket } from '../panel/history/ledger-schema.ts';

for (const item of corpus.capabilityCases) test(`shared Swift/TS capability: ${item.name}`, async () => {
  const routes = item.routes as Record<string, Route>, clock = { now: 100_000 };
  const { context } = routeContext(() => routes, clock);
  const adapter = (item.kind === 'ollama' ? ollamaDescriptor : mlxLmDescriptor).create(context);
  const reading = await adapter.read(READ);
  expect({ catalogue: reading.runtime.catalog.length > 0 || reading.runtime.residency.length > 0,
    residency: reading.runtime.residency.length > 0, requests: reading.runtime.server.active !== null }).toEqual(item.expected);
  expect(reading.runtime.phase).toBe('unknown'); expect(reading.runtime.request).toBeNull();
});

for (const item of corpus.vllmCases) test(`shared Swift/TS freshness: ${item.name}`, async () => {
  let status: Record<string, unknown> = {};
  const clock = { now: 100_000 }, { context } = routeContext(() => ({ '/v1/status': status }), clock);
  const adapter = vllmMlxDescriptor.create(context);
  for (const step of item.steps) {
    clock.now += step.advanceMs;
    status = { status: 'running', model: 'contract-model', num_running: step.active, num_waiting: 0,
      requests: [{ request_id: 'private-contract-id', status: 'running', phase: 'generation',
        completion_tokens: step.tokens, tokens_per_second: 42, elapsed_s: 3, prompt_tokens: 100 }] };
    const reading = await adapter.read(READ);
    expect(String(reading.runtime.phase)).toBe(step.expectedPhase);
    expect(reading.runtime.request?.decodeTps ?? null).toBe(step.expectedRate);
  }
});

for (const item of corpus.llamaCases) test(`shared Swift/TS rate and completion: ${item.name}`, async () => {
  let slots: unknown = [];
  const clock = { now: 100_000 }, { context } = routeContext(() => ({ '/health': { status: 'ok' },
    '/props': { build_info: 'b6700-contract', endpoint_metrics: false, endpoint_slots: true, total_slots: 1, model_alias: 'contract-model' } }), clock);
  context.getText = async path => ({ status: path === '/slots' ? 200 : 404, text: path === '/slots' ? JSON.stringify(slots) : '' });
  const adapter = llamaDescriptor.create(context);
  for (const step of item.steps) {
    clock.now += step.advanceMs;
    slots = [{ id: 0, id_task: 1, n_ctx: 8192, is_processing: step.busy, n_prompt_tokens_processed: 100,
      n_prompt_tokens_cache: 0, next_token: { n_decoded: step.tokens } }];
    const reading = await adapter.read(READ);
    expect(String(reading.runtime.phase)).toBe(step.expectedPhase);
    expect(reading.runtime.request?.decodeTps ?? null).toBe(step.expectedRate);
    expect(reading.completions.length > 0).toBe(step.expectedCompletion);
    if (step.expectedCompletion) {
      expect(reading.completions[0]?.basis).toBe('observed');
      expect(reading.completions[0]?.outputTokens ?? null).toBe('expectedOutput' in step ? step.expectedOutput ?? null : null);
    }
  }
});

for (const item of corpus.comparisonCases) test(`shared Swift/TS comparison: ${item.name}`, () => {
  const row = (value: typeof item.a | typeof item.b, at: number) => reply({ at, rt: value.runtime as RuntimeKind,
    modelRef: value.model === null ? null : 0, basis: ({ 'reported-completion': 'reported',
      'reported-observation': 'last-observed', 'measured-output': 'observed' } as Record<string, Basis>)[value.basis],
    ctxB: value.contextBucket as SizeBucket, uncB: value.inputBucket as SizeBucket,
    decodeTps: value.rate, ttftMs: value.firstToken * 1000, cofactors: value.overlap ? 8 : 0 });
  expect(compareRuns(row(item.a, 100_000), row(item.b, 99_000)).map(value => value.label)).toEqual(item.expectedMetrics);
});
