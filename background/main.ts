import type { AttachIssueRequest, HostClient, ResolveRequest } from '@openchamber/sdk';

// Owner: scope-flip. The `/scope` background frame (≤ 25 KB): handles onResolve only, with one
// /v2/snapshot?surface=background read. Never polls, never subscribes to sessions, never a lease candidate.
// Not bundled yet: the build script, manifest `background.entry` and verify-package ceilings arrive with Stage 7/11.

export const resolveScope = async (host: Pick<HostClient, 'serviceRequest'>, request: ResolveRequest): Promise<AttachIssueRequest | null> => {
  void host; void request;
  throw new Error('resolveScope: not implemented (scope-flip)');
};
