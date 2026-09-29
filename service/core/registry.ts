import type { Runtime } from '../../src/runtime.ts';
import type { TelemetrySnapshot } from '../../src/telemetry.ts';
import type { RuntimeRead } from '../adapter.ts';
import type { OmlxConfig } from '../config.ts';
import { HttpFailure, type FetchImplementation, type JsonResponse } from '../http.ts';
import { LMStudioClient } from '../lmstudio.ts';
import type { ActivitySource } from '../lmstudio-activity.ts';
import { MlxLmClient } from '../mlx-lm.ts';
import { isOmlxHealth, OmlxClient } from '../omlx-client.ts';
import { SplashClient } from '../splash.ts';
import { VllmMlxClient } from '../vllm-mlx.ts';
import { obj, type Json } from '../lib/parse.ts';
import { HINTS } from './hints.ts';

export type Confidence = 'high' | 'medium' | 'low';
/** 1.6's capability tier for a reading; convert-v1 maps it to v2 capability keys. */
export type Coverage = 'requests' | 'inventory' | 'server';

/** Detection probes in 1.6 order. `absent` statuses mean "not this runtime"; any other failure ends the pass. */
export const PROBES = [
  { path: '/health', authenticated: false, absent: [401, 403, 404] },
  { path: '/api/v1/models', authenticated: true, absent: [404] },
  { path: '/status', authenticated: true, absent: [404, 405] },
  { path: '/v1/models', authenticated: true, absent: [] },
] as const;
export type ProbePath = typeof PROBES[number]['path'];
export type ProbeRead = (path: ProbePath, authenticated: boolean) => Promise<Pick<JsonResponse, 'status' | 'body'>>;
export interface Detection { runtime: Runtime; confidence: Confidence; probe: ProbePath }

export interface Adapter { snapshot(deadline?: number): Promise<TelemetrySnapshot> }
export interface AdapterContext {
  read: RuntimeRead;
  config: OmlxConfig;
  fetchImpl: FetchImplementation;
  now: () => number;
  monotonic: () => number;
  timeoutMs: number;
  budgetMs: number;
  activity: () => ActivitySource | null;     // asked only by the runtime that streams activity
}
export interface RuntimeDescriptor {
  id: Runtime;
  hints: (id: string, name: string) => boolean;
  detect: ReadonlyArray<{ probe: ProbePath; confidence: Confidence; match: (reply: { status: number; body: Json | null }) => boolean }>;
  cadence: (context: { activity: boolean }) => number;
  capabilities: (reading: TelemetrySnapshot) => Coverage;
  create: (context: AdapterContext) => Adapter;
}

const hint = (runtime: Runtime) => HINTS.find(([id]) => id === runtime)![1];
const VLLM_OWNERS = ['vllm-mlx', 'vllm-mlx-embedding', 'vllm-mlx-reranker'];

/** One entry per runtime: adding a runtime is one adapter file and one line here. */
export const DESCRIPTORS: readonly RuntimeDescriptor[] = [
  { id: 'omlx', hints: hint('omlx'), cadence: () => 450, capabilities: () => 'requests',
    detect: [{ probe: '/health', confidence: 'high', match: reply => isOmlxHealth(reply.body, reply.status) }],
    create: context => new OmlxClient({ fetchImpl: context.fetchImpl, readConfig: async () => context.config, now: context.now,
      monotonicNow: context.monotonic, requestTimeoutMs: context.timeoutMs, collectionDeadlineMs: context.budgetMs }) },
  { id: 'lmstudio', hints: hint('lmstudio'), cadence: ({ activity }) => activity ? 1000 : 5000,
    capabilities: reading => reading.available && reading.phase !== 'unknown' ? 'requests' : 'inventory',
    detect: [{ probe: '/api/v1/models', confidence: 'medium', match: reply => Array.isArray(reply.body?.models) }],
    create: context => new LMStudioClient(context.read, context.now, context.activity()) },
  { id: 'mlx-lm', hints: hint('mlx-lm'), cadence: () => 2000, capabilities: () => 'inventory', detect: [],
    create: context => new MlxLmClient(context.read, context.now) },
  { id: 'vllm-mlx', hints: hint('vllm-mlx'), cadence: () => 450,
    capabilities: reading => reading.available && reading.phase === 'unknown' && reading.activeRequests === null ? 'server' : 'requests',
    detect: [
      { probe: '/health', confidence: 'medium', match: ({ body }) => body !== null && typeof body.model_loaded === 'boolean'
        && ['simple', 'batched', 'unknown'].includes(String(body.engine_type)) && Array.isArray(body.available_models) },
      { probe: '/v1/models', confidence: 'high', match: ({ body }) => {
        const owners = (Array.isArray(body?.data) ? body.data : []).map(model => obj(model)?.owned_by ?? null);
        return owners.includes('vllm-mlx') && owners.every(owner => VLLM_OWNERS.includes(String(owner)));
      } },
    ],
    create: context => new VllmMlxClient(context.read, context.now) },
  { id: 'splash', hints: hint('splash'), cadence: () => 2000, capabilities: () => 'server',
    detect: [{ probe: '/status', confidence: 'medium', match: reply => typeof reply.body?.ready === 'boolean' }],
    create: context => new SplashClient(context.read, context.now) },
];
export const descriptor = (runtime: Runtime): RuntimeDescriptor => DESCRIPTORS.find(item => item.id === runtime)!;
/** Before detection there is no descriptor; an unknown endpoint is probed at the floor cadence. */
export const cadenceOf = (runtime: Runtime | null, context: { activity: boolean }): number =>
  runtime ? descriptor(runtime).cadence(context) : 450;

/**
 * One detection pass: each probe at most once, in 1.6 order, and within a probe the descriptors in registry order.
 * mlx-lm has no probe and is chosen by hint only. Null when nothing identifies itself.
 */
export const detectRuntime = async (read: ProbeRead): Promise<Detection | null> => {
  for (const { path, authenticated, absent } of PROBES) {
    let reply: Pick<JsonResponse, 'status' | 'body'>;
    try { reply = await read(path, authenticated); }
    catch (error) {
      if (error instanceof HttpFailure && (absent as readonly number[]).includes(error.status ?? 0)) continue;
      throw error;
    }
    for (const item of DESCRIPTORS) {
      const step = item.detect.find(candidate => candidate.probe === path && candidate.match(reply));
      if (step) return { runtime: item.id, confidence: step.confidence, probe: path };
    }
  }
  return null;
};
