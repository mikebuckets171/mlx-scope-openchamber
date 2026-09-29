import type { DescriptorV2 } from '../core/adapter-v2.ts';

// Owner: ad-omlx. Rewrite of service/omlx-client.ts on the v2 contract: oMLX 0.7, /api/status fallback on admin 401/403
// (reason admin_unauthorized, server coverage), engine_pool.final_ceiling → ceilingBytes, never /admin/api/stats.
// The normalizer moves verbatim to ./omlx-normalize.ts (git mv of src/telemetry.ts:272-657, unit renames only).

export const omlxDescriptor: DescriptorV2 = {
  id: 'omlx', hints: () => false, detect: [], cadence: () => 2_000, capabilities: [], identityEveryMs: 300_000,
  create: () => { throw new Error('omlx adapter: not implemented (ad-omlx)'); },
};
