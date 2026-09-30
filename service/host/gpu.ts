import { defined } from '../../src/contract/guards.ts';
import type { HostV2 } from '../../src/contract/host.ts';
import { IOREG_MAX_BYTES } from '../lib/argv.ts';

// Owner: svc-host. ioreg IOAccelerator PerformanceStatistics: driver-reported; never a headline, score or alert (G1).
// Only the closed, one-line PerformanceStatistics dictionary is read. AGCInfo (it holds a PID), the scheduler state and
// the IOReportLegend channel names are never touched.

const STATS = /^[ \t]+"PerformanceStatistics" = \{(.*)\}$/gm;
/** One exact `"key"=<integer>` pair; the closing quote keeps "In use system memory (driver)" from matching. */
const stat = (dictionary: string, key: string): number | undefined => {
  const match = new RegExp(`(?:^|,)"${key.replace(/[.*+?^${}()|[\]\\%]/g, '\\$&')}"=(\\d{1,16})(?=,|$)`).exec(dictionary);
  const value = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(value) ? value : undefined;
};
const percent = (value: number | undefined): number | undefined => value !== undefined && value <= 100 ? value / 100 : undefined;

/**
 * GPU busy ("Device Utilization %", else the renderer's) and the driver's system-memory figures. Alloc includes reserved,
 * unfilled memory and other apps' (SPIKES S9): "GPU memory (driver-reported, not model size)", never an alert input.
 * Oversize output is refused whole (never a prefix), and more than one accelerator is ambiguous, so both read as absent.
 */
export const parseIoreg = (output: string | null, sampledAt: number): HostV2['gpu'] | undefined => {
  if (!output || Buffer.byteLength(output, 'utf8') > IOREG_MAX_BYTES) return undefined;
  const dictionaries = [...output.matchAll(STATS)];
  if (dictionaries.length !== 1) return undefined;
  const dictionary = dictionaries[0]![1]!;
  const gpu = defined({
    busyFraction: percent(stat(dictionary, 'Device Utilization %')) ?? percent(stat(dictionary, 'Renderer Utilization %')),
    allocBytes: stat(dictionary, 'Alloc system memory'), inUseBytes: stat(dictionary, 'In use system memory'),
  });
  return Object.keys(gpu).length ? { sampledAt, ...gpu } : undefined;
};
