/** Value guards shared by every v2 parser. Parsers rebuild objects from allowlists; nothing is spread through. */
export type Json = Record<string, unknown>;

export const obj = (value: unknown): Json | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
export const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
export const nonneg = (value: unknown): number | null => { const n = finite(value); return n !== null && n >= 0 ? n : null; };
export const count = (value: unknown): number | null => { const n = nonneg(value); return n !== null && Number.isSafeInteger(n) ? n : null; };
export const signedInt = (value: unknown): number | null => Number.isSafeInteger(value) ? value as number : null;
export const fraction = (value: unknown): number | null => { const n = nonneg(value); return n !== null && n <= 1 ? n : null; };
export const bool = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
export const oneOf = <T extends string | number>(values: readonly T[]) =>
  (value: unknown): T | null => values.includes(value as T) ? value as T : null;
/** Epoch milliseconds: finite, not negative, and inside the Date range. */
export const at = (value: unknown): number | null => { const n = nonneg(value); return n !== null && n <= 8.64e15 ? n : null; };

const CONTROL = /[\u0000-\u001f\u007f]/g;
export const label = (value: unknown, max = 120): string | null =>
  typeof value === 'string' ? value.replace(CONTROL, '').trim().slice(0, max) || null : null;
/** A model name, never a path: absolute, relative, home and drive paths keep only their last segment. */
export const modelLabel = (value: unknown, max = 256): string | null => {
  const clean = label(value, Infinity);
  if (!clean) return null;
  const name = /^(?:[\\/]|\.{1,2}[\\/]|~[\\/]|file:|[A-Za-z]:[\\/])/.test(clean) ? clean.split(/[\\/]/).filter(Boolean).at(-1) : clean;
  return name?.slice(0, max) || null;
};

export const CONNECTION_ID = /^[A-Za-z0-9._-]{1,64}$/;
export const HEX8 = /^[0-9a-f]{8}$/;
export const connectionId = (value: unknown): string | null => typeof value === 'string' && CONNECTION_ID.test(value) ? value : null;
export const hex8 = (value: unknown): string | null => typeof value === 'string' && HEX8.test(value) ? value : null;

/** Drop invalid entries, then keep at most `max`. */
export const list = <T>(value: unknown, max: number, item: (raw: unknown) => T | null): T[] => {
  const result: T[] = [];
  for (const raw of arr(value)) {
    if (result.length >= max) break;
    const parsed = item(raw);
    if (parsed !== null) result.push(parsed);
  }
  return result;
};
/** Optional fields are absent, never `undefined` or `null`: `defined({ a: opt(x) })`. */
export const opt = <T>(value: T | null | undefined): T | undefined => value ?? undefined;
export const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

/** The SDK response limit (contract §1). Every body must stay strictly below it. */
export const MAX_BODY_CHARS = 256_000;
export const bodyChars = (value: unknown): number => (typeof value === 'string' ? value : JSON.stringify(value)).length;
export const assertBodyLimit = (value: unknown): string => {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  if (body.length >= MAX_BODY_CHARS) throw new RangeError(`Response body is ${body.length} characters; the limit is ${MAX_BODY_CHARS - 1}.`);
  return body;
};

/**
 * Class A (contract §9): never on the wire. A body carrying any of these keys is rejected whole, because its
 * presence means a service leak, and a frame must not render the rest of that body as trustworthy.
 */
export const CLASS_A_KEYS: ReadonlySet<string> = new Set([
  'pid', 'ppid', 'api_key', 'apikey', 'cookie', 'cookies', 'set-cookie', 'authorization', 'token', 'secret', 'password',
  'prompt', 'generation_prompt', 'messages', 'content', 'response', 'text', 'path', 'model_path', 'file', 'filename',
  'directory', 'folder', 'cwd', 'worktree', 'project', 'projectname', 'sessionid', 'session_id', 'sessiontitle', 'title',
  'request_id', 'requestid', 'tag', 'tag8', 'last_crash_trace', 'crash_trace', 'error', 'identity', 'username', 'user',
  'host_name', 'hostname',
]);
export const classAKeys = (value: unknown, path = '', found: string[] = []): string[] => {
  if (Array.isArray(value)) value.forEach((item, index) => classAKeys(item, `${path}[${index}]`, found));
  else if (obj(value)) for (const [key, item] of Object.entries(value as Json)) {
    const at = path ? `${path}.${key}` : key;
    if (CLASS_A_KEYS.has(key.toLowerCase())) found.push(at);
    classAKeys(item, at, found);
  }
  return found;
};
