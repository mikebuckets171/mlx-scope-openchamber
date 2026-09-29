import type { DescriptorV2 } from '../core/adapter-v2.ts';

// Owner: svc-2b. Rewrite of service/mlx-lm.ts; hint-only detection; an optional /v1/models degrades its capability.

export const mlxLmDescriptor: DescriptorV2 = {
  id: 'mlx-lm', hints: () => false, detect: [], cadence: () => 2_000, capabilities: [], identityEveryMs: 60_000,
  create: () => { throw new Error('mlx-lm adapter: not implemented (svc-2b)'); },
};
