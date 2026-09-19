import { HostRequestError, isHostRequestErrorCode } from '@openchamber/sdk';
import { unavailableTelemetry, type TelemetryReason, type UnavailableTelemetry } from '../src/telemetry.ts';

type Diagnostic = {
  reason: TelemetryReason;
  message: string;
};

const diagnosticForCode = (code: string): Diagnostic => {
  switch (code) {
    case 'DISCONNECTED':
      return { reason: 'host_disconnected', message: 'OpenChamber disconnected this extension. Reopen the panel to reconnect.' };
    case 'DISABLED':
    case 'NOT_GRANTED':
      return { reason: 'service_not_granted', message: 'Approve the extension’s local service in Settings → Extensions.' };
    case 'NO_SERVICE':
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

export const unavailableForHostError = (error: unknown, sampledAt = Date.now()): UnavailableTelemetry => {
  const code = error instanceof HostRequestError && isHostRequestErrorCode(error.code) ? error.code : null;
  const diagnostic = code === null
    ? { reason: 'host_unavailable' as const, message: 'OpenChamber did not return a service response. Reopen the panel and try again.' }
    : diagnosticForCode(code);
  return unavailableTelemetry(diagnostic.reason, diagnostic.message, sampledAt);
};

export const unavailableForServiceResponse = (status: number, sampledAt = Date.now()): UnavailableTelemetry => (
  unavailableTelemetry(
    'service_failed',
    status === 401
      ? 'The extension service authorization was rejected by OpenChamber.'
      : `The MLX Scope service returned HTTP ${status}. Reopen the extension and try again.`,
    sampledAt,
  )
);

export const __test__ = { diagnosticForCode };
