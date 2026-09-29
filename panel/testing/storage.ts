import type { HostClient } from '@openchamber/sdk';

// Owner: ledger. A fake host.storage enforcing the host limits and the whole-file rewrite (S5), shared by ledger,
// ui-history and ui-core tests. Every failure is the same HOST_REJECTED, as the host sends it.

export interface FakeStorageStats { gets: number; sets: number; deletes: number; keys: number; bytesWritten: number }
export const createFakeStorage = (options: { reject?: (op: 'get' | 'set' | 'delete' | 'keys', key?: string) => boolean } = {}):
  HostClient['storage'] & { stats(): FakeStorageStats; dump(): Record<string, unknown> } => {
  void options;
  throw new Error('createFakeStorage: not implemented (ledger)');
};
