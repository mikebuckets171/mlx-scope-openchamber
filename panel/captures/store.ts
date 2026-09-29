import type { HostClient } from '@openchamber/sdk';

// Owner: ledger. Saved captures (capture.v2.<ts36>, ≤ 12), successor of panel/saved.ts. Class B: no model names stored.

export const CAPTURE_LIMIT = 12;
export interface CaptureV2 {
  v: 2;
  savedAt: number;
  kind: 'snapshot' | 'window' | 'next-reply' | 'comparison';
  runtime: string | null;                    // RuntimeKind or null; never a model name
  label: 'server-wide' | 'armed';
  measurements: Record<string, number>;      // allowlisted keys in bytes/ms/tps/fraction units
  reference?: Record<string, number>;
  state: 'finished' | 'interrupted';
}
export class CaptureStore {
  constructor(private readonly storage: HostClient['storage']) {}
  async list(): Promise<CaptureV2[]> { void this.storage; return []; }
  async save(capture: CaptureV2): Promise<string> { void capture; throw new Error('CaptureStore: not implemented (ledger)'); }
  async remove(key: string): Promise<void> { void key; }
}
