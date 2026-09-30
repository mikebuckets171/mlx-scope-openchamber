import type { RuntimeKind } from '../../src/contract/runtime.ts';
import { llamaDescriptor } from '../adapters/llama-server.ts';
import { mlxLmDescriptor } from '../adapters/mlx-lm.ts';
import { ollamaDescriptor } from '../adapters/ollama.ts';
import { vllmMlxDescriptor } from '../adapters/vllm-mlx.ts';
import { DETECT_ORDER, type DescriptorV2, type DetectProbe, type RuntimeGet, type RuntimeReply } from './adapter-v2.ts';
import { legacyLMStudio, legacyOmlx, legacySplash, type LegacyExtras } from './legacy.ts';

export type Confidence = 'high' | 'medium' | 'low';
export interface Detection { runtime: RuntimeKind; confidence: Confidence; probe: DetectProbe }
/** A pass that identified nothing: `locked` when some probe answered 401/403, so a runtime is there but refused the key. */
export interface NoDetection { runtime: null; locked: boolean }

/**
 * One entry per runtime: adding a runtime is one adapter file and one line here. oMLX, LM Studio and Splash still run
 * their 1.6 clients through the bridge (./legacy.ts); their tracks swap in `omlxDescriptor`, `lmstudioDescriptor` and
 * `splashDescriptor`. Registry order breaks ties between descriptors that share a probe.
 */
export const descriptorsWith = (extras: LegacyExtras): readonly DescriptorV2[] =>
  [legacyOmlx, legacyLMStudio(extras), mlxLmDescriptor, vllmMlxDescriptor, legacySplash, llamaDescriptor, ollamaDescriptor];
export const DESCRIPTORS = descriptorsWith({ activity: () => null });
export const descriptorOf = (descriptors: readonly DescriptorV2[], runtime: RuntimeKind): DescriptorV2 | null =>
  descriptors.find(item => item.id === runtime) ?? null;

/**
 * One detection pass (plan §5.1). Each path is fetched at most once, including the descriptors' own follow-up GETs. The
 * hinted descriptor's steps run first, then every step in probe order (DETECT_ORDER), descriptors in registry order. Any
 * status reaches the matchers: a 404, 405 or LM Studio's 200 "Unexpected endpoint" means absent, and a 401/403 means an
 * authenticated runtime is present. A request that cannot complete (refused, timed out, redirected) ends the pass by
 * throwing, as 1.6 did. mlx-lm has no step: only a hint or an explicit choice selects it.
 */
export const detect = async (descriptors: readonly DescriptorV2[], get: RuntimeGet, hinted: RuntimeKind | null = null): Promise<Detection | NoDetection> => {
  const cache = new Map<string, Promise<RuntimeReply>>();
  let locked = false;
  const cached: RuntimeGet = path => {
    let reply = cache.get(path);
    if (!reply) {
      reply = get(path).then(value => { if (value.status === 401 || value.status === 403) locked = true; return value; });
      cache.set(path, reply);
    }
    return reply;
  };
  const first = hinted ? descriptors.filter(item => item.id === hinted) : [];
  const steps = [
    ...first.flatMap(item => item.detect.map(step => ({ item, step }))),
    ...DETECT_ORDER.flatMap(probe => descriptors.flatMap(item => item.detect.filter(step => step.probe === probe).map(step => ({ item, step })))),
  ];
  for (const { item, step } of steps) {
    if (await step.match(await cached(step.probe), cached)) return { runtime: item.id, confidence: step.confidence, probe: step.probe };
  }
  return { runtime: null, locked };
};
