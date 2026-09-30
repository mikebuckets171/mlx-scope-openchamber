import { processId } from '../lib/argv.ts';

// Owner: svc-host. oMLX only: lsof listener → footprint. PIDs live in service memory only (class A).

/** `lsof -t`: one PID per line. Any other line means unexpected output, so nothing is trusted. */
export const parseLsofPids = (output: string | null): number[] => {
  const lines = (output ?? '').split('\n').filter(line => line !== '');
  const pids = lines.map(line => /^\d{1,7}$/.test(line) ? processId(Number(line)) : null);
  return pids.every((pid): pid is number => pid !== null) ? [...new Set(pids)] : [];
};

/** What one `footprint --noCategories -f bytes -p <pid>` report says. `name` and `pid` never leave the service. */
export interface FootprintReport { name: string; pid: number; footprintBytes: number; peakBytes: number }
const HEADER = /^(\S.*?) \[(\d{1,7})\]: \d+-bit +Footprint: (\d{1,16}) B \(\d+ bytes per page\)$/gm;
const AUX = /^Auxiliary data:\n {4}phys_footprint: (\d{1,16}) B\n {4}phys_footprint_peak: (\d{1,16}) B$/m;
/** Exact bytes only: the formatted form ("19 GB") is rounded, and a rounded number must not pass as bytes. */
export const parseFootprintReport = (output: string | null): FootprintReport | null => {
  const headers = [...(output ?? '').matchAll(HEADER)], aux = AUX.exec(output ?? '');
  if (headers.length !== 1 || !aux) return null;
  const [, name, pid, header] = headers[0]!;
  const footprintBytes = Number(aux[1]), peakBytes = Number(aux[2]), id = processId(Number(pid));
  const valid = [footprintBytes, peakBytes].every(Number.isSafeInteger) && Number(header) === footprintBytes && peakBytes >= footprintBytes;
  return valid && id !== null ? { name: name!, pid: id, footprintBytes, peakBytes } : null;
};
/** Physical footprint in bytes; prefer exact `-f bytes` values if that argv is allowlisted. */
export const parseFootprint = (output: string | null): number | null => parseFootprintReport(output)?.footprintBytes ?? null;

/**
 * The PID-reuse guard. G1 froze exec without `/bin/ps`, so the start-time re-check is replaced by the report itself: the
 * same PID must keep the same process name, and its lifetime peak can never shrink. A process that reused the PID
 * starts a new peak, so it fails the check and the listener is looked up again.
 */
export const sameProcess = (first: Pick<FootprintReport, 'name' | 'pid' | 'peakBytes'>, next: FootprintReport): boolean =>
  next.pid === first.pid && next.name === first.name && next.peakBytes >= first.peakBytes;
