import type { StatusV2 } from '../../src/contract/snapshot.ts';
import type { CompletionDraft, DescriptorV2 } from '../core/adapter-v2.ts';

// Owner: ad-splash. Splash 1.1 via /status only (G1: no /metrics). Precedence recovering > status_stale > not admitting
// > ready; native ttft_ms/itl_ms p50/p95 with n; never forward last_crash_trace, transport.error, instance.*, identity.*.

/** While transport.recovering, runtime reads are cached this long so Scope never joins the restart retries. */
export const SPLASH_RECOVERING_CACHE_MS = 30_000;
/** The state and reason a /status body means (params hold booleans only, e.g. crashTrace). */
export const splashStatus = (body: unknown): StatusV2 => {
  void body;
  return { state: 'detecting', reason: 'detecting', params: {} };
};
/** A completion only when TTFT count Δ=1, completed Δ=1, active ≤ 1 at both reads and nothing queued; else aggregateOf. */
export const splashCompletion = (before: unknown, after: unknown, at: number): CompletionDraft | null => {
  void before; void after; void at;
  return null;
};

export const splashDescriptor: DescriptorV2 = {
  id: 'splash', hints: () => false, detect: [], cadence: () => 2_000, capabilities: [], identityEveryMs: 60_000,
  create: () => { throw new Error('splash adapter: not implemented (ad-splash)'); },
};
