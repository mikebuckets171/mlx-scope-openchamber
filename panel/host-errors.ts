import { HostRequestError, isHostRequestErrorCode } from '@openchamber/sdk';
import type { PanelReason } from './present/reading.ts';

/** Why the frame has no reading, in the 1.6 vocabulary; the message never carries raw host error text. */
export type Diagnostic = {
  reason: PanelReason;
  message: string;
};

const diagnosticForCode = (code: string): Diagnostic => {
  switch (code) {
    case 'DISCONNECTED':
      return { reason: 'host_disconnected', message: 'OpenChamber disconnected this extension. Reopen the panel to reconnect.' };
    // An update that changed the permission set leaves every request NO_SERVICE until the owner approves (SPIKES S11).
    case 'NO_SERVICE':
    case 'DISABLED':
    case 'NOT_GRANTED':
      return { reason: 'needs_approval', message: 'Allow MLX Scope’s local service in Settings → Extensions.' };
    case 'SERVICE_FAILED':
      return { reason: 'service_failed', message: 'The MLX Scope service is stopped or failed. Reopen the extension or check its approval.' };
    case 'HOST_TIMEOUT':
      return { reason: 'host_timeout', message: 'OpenChamber service access timed out before returning a reading. Try refresh again.' };
    case 'HOST_REJECTED':
    case 'BAD_PATH':
    case 'NO_INTEGRATION':
    case 'NO_SESSION':
    case 'SESSION_BUSY':
    case 'NO_DIRECTORY':
    case 'NOT_FOUND':
    case 'FILE_TOO_LARGE':
    case 'DENIED':
    case 'NO_MODEL':
    case 'MODEL_FAILED':
      return { reason: 'host_rejected', message: `OpenChamber rejected this service request (${code}).` };
    case 'HOST_UNAVAILABLE':
    default:
      return { reason: 'host_unavailable', message: 'OpenChamber could not reach the MLX Scope service. Reopen the panel and try again.' };
  }
};

export const unavailableForHostError = (error: unknown): Diagnostic => {
  const code = error instanceof HostRequestError && isHostRequestErrorCode(error.code) ? error.code : null;
  return code === null
    ? { reason: 'host_unavailable', message: 'OpenChamber did not return a service response. Reopen the panel and try again.' }
    : diagnosticForCode(code);
};

export const unavailableForServiceResponse = (status: number): Diagnostic => ({
  reason: 'service_failed',
  message: status === 401
    ? 'The extension service authorization was rejected by OpenChamber.'
    : `The MLX Scope service returned HTTP ${status}. Reopen the extension and try again.`,
});

export const __test__ = { diagnosticForCode };
