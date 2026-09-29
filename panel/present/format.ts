// The panel's only number formatting. Memory arrives as integer bytes (contract §3) and is shown in GiB (1,024³ bytes);
// no other module converts bytes. Locale follows the host frame, as in 1.6.
const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const oneDecimal = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compactNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
type N = number | null | undefined;

export const EMPTY = '—';
/** Bytes → GiB as a number, for meters, means, saved measurements and reports. */
export const gib = (bytes: N): number | null => bytes == null ? null : bytes / 1024 ** 3;
/** `36.1 GiB`, or a dash. */
export const gibText = (bytes: N): string => bytes == null ? EMPTY : `${decimal.format(bytes / 1024 ** 3)} GiB`;
/** Fixed decimals for captures and copied reports: `12.10`. */
export const gibFixed = (bytes: number, digits: number): string => (bytes / 1024 ** 3).toFixed(digits);
/** The GiB figure alone, without the unit: the used half of `36.1 / 48 GiB`. */
export const gibNumber = (bytes: N): string => bytes == null ? EMPTY : decimal.format(bytes / 1024 ** 3);

export const decimalText = (value: number): string => decimal.format(value);
export const oneDecimalText = (value: number): string => oneDecimal.format(value);
export const wholeText = (value: number): string => whole.format(value);
export const count = (value: N): string => value == null ? EMPTY : compactNumber.format(value);
/** A reported rate, always with one decimal: `24.6 tok/s`. */
export const rate = (value: N): string => value == null ? EMPTY : `${oneDecimal.format(value)} tok/s`;
/** An observed or per-model rate, at most one decimal: `24 tok/s`. */
export const looseRate = (value: number | null): string => value === null ? EMPTY : `${decimal.format(value)} tok/s`;
export const percent = (value: N): string => value == null ? EMPTY : `${Math.round(value)}%`;
export const ratio = (a: N, b: N): number | null => a == null || b == null || b <= 0 ? null : a / b * 100;
export const seconds = (ms: N): string => ms == null ? EMPTY : `${decimal.format(ms / 1000)}s`;
/** Copied and saved reports: at most two decimals, no grouping. */
export const scalar = (value: N, unit = ''): string => value == null || !Number.isFinite(value) ? 'not reported' : `${Number(value.toFixed(2))}${unit}`;

const elapsed = (at: number, now: number): number => Math.max(0, Math.floor((now - at) / 1000));
export const age = (at: number, now: number): string => {
  const s = elapsed(at, now);
  return s < 3 ? 'Updated now' : s < 60 ? `Updated ${s}s ago` : `Updated ${Math.floor(s / 60)}m ago`;
};
export const finishedAgo = (at: number, now: number): string => {
  const s = elapsed(at, now);
  return s < 3 ? 'just finished' : s < 60 ? `finished ${s}s ago` : `finished ${Math.floor(s / 60)}m ago`;
};
/** Uptime as `14h 17m · since start`. */
export const uptime = (ms: number): string => {
  const s = ms / 1000;
  return `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m · since start`;
};
