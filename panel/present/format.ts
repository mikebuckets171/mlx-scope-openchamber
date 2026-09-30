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

// 2.0 view formats (the approved mock). Every duration, size and rate on the 2.0 surfaces goes through these.
const grouped = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
/** A rate: one decimal below 100, whole above. */
export const tps = (value: number): string => value >= 100 ? grouped.format(Math.round(value)) : value.toFixed(1);
/** Whole numbers with grouping: `1,104`. */
export const int = (value: number): string => grouped.format(Math.round(value));
/** Token counts: `52.7K`, `1.31M`, `612`. */
export const kt = (value: number): string => value >= 1e6 ? `${(value / 1e6).toFixed(value >= 1e7 ? 1 : 2)}M`
  : value >= 1e5 ? `${Math.round(value / 1e3)}K` : value >= 1e4 ? `${(value / 1e3).toFixed(1)}K` : int(value);
export const pct = (value: number): string => `${Math.round(value * 100)}%`;
/** A signed change: `+2%`, `−17%`, `±0%`. */
export const delta = (value: number): string => `${value > 0.004 ? '+' : value < -0.004 ? '−' : '±'}${Math.abs(Math.round(value * 100))}%`;
/** Bytes as GiB with one decimal: `17.1 GiB`. */
export const size = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
export const dur = (ms: number): string => ms < 1_000 ? `${(ms / 1_000).toFixed(2)} s` : ms < 10_000 ? `${(ms / 1_000).toFixed(1)} s`
  : ms < 60_000 ? `${Math.round(ms / 1_000)} s`
    : ms < 3_600_000 ? ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.floor(ms / 60_000)} m ${String(Math.floor(ms % 60_000 / 1_000)).padStart(2, '0')} s`
      : `${Math.floor(ms / 3_600_000)} h ${Math.floor(ms % 3_600_000 / 60_000)} m`;
export const ago = (at: number, now: number): string => {
  const d = Math.max(0, now - at);
  return d < 5_000 ? 'just now' : d < 60_000 ? `${Math.round(d / 1_000)} s ago` : d < 3_600_000 ? `${Math.round(d / 60_000)} min ago` : `${Math.round(d / 3_600_000)} h ago`;
};
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
/** A wall-clock time today (`14:01`), otherwise the day (`Sep 28`). */
export const clock = (at: number, now: number): string => new Date(at).toDateString() === new Date(now).toDateString() ? time.format(at) : day.format(at);
export const mmss = (ms: number): string => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms % 60_000 / 1_000)).padStart(2, '0')}`;
