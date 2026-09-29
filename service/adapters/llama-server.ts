import type { RuntimeV2, SlotV2 } from '../../src/contract/snapshot.ts';
import type { CompletionDraft, DescriptorV2 } from '../core/adapter-v2.ts';
import type { PromParse } from '../lib/prometheus.ts';

// Owner: ad-llama-ollama. S7b rule: /slots only while /metrics shows requests_processing ≥ 1 on sleep-capable builds;
// /slots numeric allowlist only; rates from Δ*_total / Δ*_seconds_total, never the windowed gauges.

export const LLAMA_METRICS: ReadonlySet<string> = new Set();
export const parseSlots = (body: unknown): SlotV2[] => { void body; return []; };
/** The only busy slot going busy → idle, with n_decoded from its last busy read (b10519 clears it on release). */
export const slotCompletion = (previous: readonly SlotV2[], next: readonly SlotV2[], at: number): CompletionDraft | null => {
  void previous; void next; void at;
  return null;
};
export const llamaRates = (previous: PromParse, next: PromParse): RuntimeV2['server']['rates'] => { void previous; void next; return undefined; };
export const llamaSpeculative = (previous: PromParse, next: PromParse): RuntimeV2['server']['speculative'] => { void previous; void next; return undefined; };

export const llamaDescriptor: DescriptorV2 = {
  id: 'llama-server', hints: () => false, detect: [], cadence: () => 2_000, capabilities: [], identityEveryMs: 60_000,
  create: () => { throw new Error('llama-server adapter: not implemented (ad-llama-ollama)'); },
};
