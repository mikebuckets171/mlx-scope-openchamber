import type { AlertId, FrameReason, ReasonParams, StatusReason, WithholdReason } from '../../src/contract/reasons.ts';
import type { RuntimeKind } from '../../src/contract/runtime.ts';

// Owner: svc-2b. The English for every contract reason code (2.0-mock copy table); the service sends codes and params
// only. This replaces the CompatV1 `message` once the panel stops reading `compat`.

export const statusMessage = (reason: StatusReason, params: ReasonParams, runtime: RuntimeKind | null): string => {
  void reason; void params; void runtime;
  throw new Error('statusMessage: not implemented (svc-2b)');
};
export const frameMessage = (reason: FrameReason): string => { void reason; throw new Error('frameMessage: not implemented (svc-2b)'); };
/** "Server-wide · <reason>"; `other-provider` becomes "This chat uses <runtime> · Watch <runtime>". */
export const withholdMessage = (reason: WithholdReason | 'all-requests', chatRuntime: RuntimeKind | null): string => {
  void reason; void chatRuntime;
  throw new Error('withholdMessage: not implemented (svc-2b)');
};
export const alertMessage = (id: AlertId, params: ReasonParams): string => { void id; void params; throw new Error('alertMessage: not implemented (svc-2b)'); };
