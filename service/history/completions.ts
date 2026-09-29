import type { CompletionsV2, CompletionV2 } from '../../src/contract/completion.ts';
import type { HostV2 } from '../../src/contract/host.ts';
import type { RuntimeV2 } from '../../src/contract/snapshot.ts';
import type { CompletionDraft } from '../core/adapter-v2.ts';
import type { VerdictV2 } from '../core/verdicts.ts';

// Owner: svc-history. The per-slot completion ring (128, monotonic seq) behind `completions` in /v2/snapshot, the
// "request disappears" detector for oMLX and vllm-mlx (absorbs panel/insights.ts SessionInsights), and host co-factors.

export const COMPLETION_RING = 128;

export class CompletionRing {
  constructor(readonly instance: string) {}
  get head(): number { return 0; }
  append(draft: CompletionDraft, host: CompletionV2['host']): CompletionV2 {
    void draft; void host;
    throw new Error('CompletionRing.append: not implemented (svc-history)');
  }
  /** Items with seq > since, oldest first, ≤ 64, each with its verdict; `reset` when since is foreign or fell off. */
  since(since: number | undefined, verdict: (seq: number) => VerdictV2 | undefined): CompletionsV2 {
    void since; void verdict;
    return { instance: this.instance, cursor: 0, reset: false, items: [] };
  }
}

/** Basis `last-observed`: the single active request's last reading before it left the active list. */
export class RequestWatch {
  observe(runtime: RuntimeV2, at: number): CompletionDraft[] { void runtime; void at; return []; }
  reset(): void {}
}

/** Host readings over a completion's span: pressure max, swap delta, GPU alloc max, thermal max, energy. */
export class HostCofactors {
  observe(host: HostV2 | null, at: number): void { void host; void at; }
  over(startedAt: number | null, finishedAt: number): CompletionV2['host'] { void startedAt; void finishedAt; return {}; }
}
