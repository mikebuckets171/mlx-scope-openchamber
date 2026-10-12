import { connectHost, HostRequestError } from '@openchamber/sdk';
import type { AttachIssueRequest, HostClient } from '../panel/host/types.ts';

export interface ResolveRequest { command: string; args: string }
type ResolverHost = Pick<HostClient, 'serviceRequest' | 'storage'> & {
  onResolve(handler: (request: ResolveRequest) => Promise<AttachIssueRequest | null>): () => void;
};
/** The on-demand command owns its SDK boundary; it never subscribes to chat activity. */
export const connectScopeCommand = (): ResolverHost => connectHost();
export const approvalRequired = (error: unknown): boolean => error instanceof HostRequestError && (error.code === 'NOT_GRANTED' || error.code === 'DISABLED');
