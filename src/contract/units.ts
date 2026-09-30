/**
 * The key suffix carries the unit (contract §3). There is no decimal GB anywhere on the wire; the only GiB formatter
 * is the panel's. The aliases document intent; `unitViolations` is the lint every body passes in tests.
 */
export type Bytes = number;     // safe integer, ≥ 0 (swapDeltaBytes is signed)
export type Ms = number;        // duration, ≥ 0
export type At = number;        // epoch ms on the service clock
export type Tps = number;       // tokens per second, ≥ 0
export type Fraction = number;  // 0…1, never a percent
export type Watts = number;     // macmon estimate
export type Tokens = number;    // integer ≥ 0

/** 1.x reported decimal GB (value / 1e9). Rounding recovers the integer the runtime or kernel reported. */
export const gbToBytes = (gb: number | null | undefined): Bytes | null => {
  if (gb == null || !Number.isFinite(gb) || gb < 0) return null;
  const bytes = Math.round(gb * 1e9);
  return Number.isSafeInteger(bytes) ? bytes : null;
};
export const bytesToGB = (bytes: Bytes | null | undefined): number | null => bytes == null ? null : bytes / 1e9;
export const secondsToMs = (seconds: number | null | undefined): Ms | null =>
  seconds == null || !Number.isFinite(seconds) || seconds < 0 ? null : seconds * 1000;
export const msToSeconds = (ms: Ms | null | undefined): number | null => ms == null ? null : ms / 1000;
export const percentToFraction = (percent: number | null | undefined): Fraction | null =>
  percent == null || !Number.isFinite(percent) || percent < 0 || percent > 100 ? null : percent / 100;
export const fractionToPercent = (value: Fraction | null | undefined): number | null => value == null ? null : value * 100;

const SIGNED_BYTES = new Set(['swapDeltaBytes']);
const rules: Array<[RegExp, (key: string, value: number) => boolean, string]> = [
  [/Bytes$/, (key, value) => Number.isSafeInteger(value) && (value >= 0 || SIGNED_BYTES.has(key)), 'a safe integer byte count'],
  [/Tokens$/, (_, value) => Number.isSafeInteger(value) && value >= 0, 'an integer token count'],
  [/Fraction$/, (_, value) => value >= 0 && value <= 1, 'within 0…1'],
  [/(?:Ms|Tps|W)$/, (_, value) => Number.isFinite(value) && value >= 0, 'finite and ≥ 0'],
  [/(?:At|^at|^serverNow|^since|^until)$/,(_, value) => Number.isFinite(value) && value >= 0 && value <= 8.64e15, 'an epoch millisecond'],
];
/** Every numeric field whose suffix names a unit must satisfy that unit. Returns the offending paths. */
export const unitViolations = (value: unknown, path = '', found: string[] = []): string[] => {
  if (Array.isArray(value)) value.forEach((item, index) => unitViolations(item, `${path}[${index}]`, found));
  else if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    const where = path ? `${path}.${key}` : key;
    if (typeof item === 'number') {
      const rule = rules.find(([suffix]) => suffix.test(key));
      if (rule && !rule[1](key, item)) found.push(`${where} must be ${rule[2]}`);
    } else unitViolations(item, where, found);
  }
  return found;
};
