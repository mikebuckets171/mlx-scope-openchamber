import { connectHost, HostRequestError } from '@openchamber/sdk-background';
import type { AttachIssueRequest, HostClient } from '../panel/host/types.ts';

export interface ResolveRequest { command: string; args: string }
type ResolverHost = Pick<HostClient, 'serviceRequest' | 'storage'> & {
  onResolve(handler: (request: ResolveRequest) => Promise<AttachIssueRequest | null>): () => void;
};
/** The unchanged on-demand apiVersion 1 command uses the official 2.0.4 SDK alias to stay within 25 KB.
 * The visible panel uses 2.3.3; no SDK fork or custom protocol is shipped here. */
export const connectScopeCommand = (): ResolverHost => connectHost();
export const approvalRequired = (error: unknown): boolean => (error instanceof HostRequestError || error instanceof Error && 'code' in error) && (error.code === 'NOT_GRANTED' || error.code === 'DISABLED');
