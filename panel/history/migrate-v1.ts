import type { HostClient } from '@openchamber/sdk';
import type { CaptureV2 } from '../captures/store.ts';

// Owner: ledger. observation.v1.* → capture.v2.* (plan §7): reuses sanitizeObservation (panel/saved.ts), GiB → bytes as
// ×2³⁰ (1.6 stored GiB), covers measurements and reference. v1 keys stay through 2.0.x.

export interface MigrationResult { migrated: number; skipped: number; at: number }
export const captureFromObservation = (value: unknown): CaptureV2 | null => { void value; return null; };
export const migrateV1 = async (storage: HostClient['storage'], now: number): Promise<MigrationResult> => {
  void storage; void now;
  throw new Error('migrateV1: not implemented (ledger)');
};
