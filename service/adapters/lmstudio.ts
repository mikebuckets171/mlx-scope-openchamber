import type { DescriptorV2 } from '../core/adapter-v2.ts';

// Owner: ad-lmstudio. LM Studio / Bionic per connection: /lmstudio-greeting liveness (no spawn), /api/v0/models state as
// the generation key, v0 fallback on a 200 route-missing body, lms only after a greeting within 10 s.

/** An opaque key over the /api/v0/models load states; a change triggers `lms ps`. Never on the wire. */
export const modelsGenerationKey = (body: unknown): string | null => {
  void body;
  return null;
};

export const lmstudioDescriptor: DescriptorV2 = {
  id: 'lmstudio', hints: () => false, detect: [], cadence: () => 2_000, capabilities: [], identityEveryMs: 60_000,
  create: () => { throw new Error('lmstudio adapter: not implemented (ad-lmstudio)'); },
};
