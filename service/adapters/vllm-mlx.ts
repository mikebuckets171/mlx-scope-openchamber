import type { DescriptorV2 } from '../core/adapter-v2.ts';

// Owner: svc-2b. Rewrite of service/vllm-mlx.ts; an optional /health degrades its capability instead of blanking.

export const vllmMlxDescriptor: DescriptorV2 = {
  id: 'vllm-mlx', hints: () => false, detect: [], cadence: () => 2_000, capabilities: [], identityEveryMs: 60_000,
  create: () => { throw new Error('vllm-mlx adapter: not implemented (svc-2b)'); },
};
