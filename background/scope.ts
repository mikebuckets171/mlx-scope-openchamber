import { HostRequestError, type AttachIssueRequest, type HostClient, type ResolveRequest } from '@openchamber/sdk';
import { version } from '../package.json';
import { obj } from '../src/contract/guards.ts';
import { CONTRACT_VERSION } from '../src/contract/version.ts';
import { scopeItem, scopeReadme, scopeText } from '../panel/share/scope.ts';
import { readUsual } from './usual.ts';

// Owner: scope-flip. The `/scope` resolver behind background/main.ts: one /v2/snapshot?surface=background read and two
// storage reads. Never polls, never subscribes to sessions, never a lease candidate, never writes.

/** `ROUTES.snapshot`, as a literal for the bundle size; a test pins it. */
export const SCOPE_PATH = '/v2/snapshot';
export const SCOPE_QUERY = { surface: 'background', tier: 'glance' } as const;
export const SCOPE_ERRORS = {
  approval: 'Approve MLX Scope in Settings → Extensions, then retry /scope.',
  unreachable: 'MLX Scope’s service did not answer. Open MLX Scope, then retry /scope.',
  mismatch: 'MLX Scope’s service is out of date. Pause and resume MLX Scope in Settings → Extensions.',
} as const;

// The host's own 20 s deadline covers a service or storage read that hangs.
const fail = (message: string): never => { throw new Error(message); };
const hostFailure = (error: unknown): never =>
  fail(error instanceof HostRequestError && (error.code === 'NOT_GRANTED' || error.code === 'DISABLED') ? SCOPE_ERRORS.approval : SCOPE_ERRORS.unreachable);

/**
 * `/scope [args]` → the "MLX Scope diagnostics" chip. `args` is ignored and never echoed: it can hold anything typed
 * after the command. A runtime that is down still gets a chip (its state is the diagnosis); a service that cannot answer
 * throws, and the host shows the message.
 */
export const resolveScope = async (host: Pick<HostClient, 'serviceRequest' | 'storage'>, request: ResolveRequest,
  now: () => number = Date.now): Promise<AttachIssueRequest | null> => {
  void request;
  const reading = host.serviceRequest({ method: 'GET', path: SCOPE_PATH, query: { ...SCOPE_QUERY } }).then(response => {
    if (response.status === 404) fail(SCOPE_ERRORS.mismatch);
    if (response.status !== 200) fail(SCOPE_ERRORS.unreachable);
    let body: unknown;
    try { body = typeof response.body === 'string' ? JSON.parse(response.body) : response.body; } catch { fail(SCOPE_ERRORS.unreachable); }
    const contract = obj(body)?.contractVersion;
    return contract === CONTRACT_VERSION ? body : fail(contract === undefined ? SCOPE_ERRORS.unreachable : SCOPE_ERRORS.mismatch);
  }, hostFailure);
  const usual = readUsual(host.storage, reading.catch(() => null));
  const snapshot = await reading;
  return scopeItem(scopeText({ version, now: now(), snapshot, vsUsual: await usual }), scopeReadme(version));
};

