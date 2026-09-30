// Owner: scope-flip. The sanitizer primitives every share path uses (P6); dependency-free so the background bundle stays small.

export const TOAST_MAX_CHARS = 500;

/** Replaces every occurrence of each forbidden string (model names, labels) with a neutral word. */
export const redact = (text: string, forbidden: readonly string[]): string =>
  forbidden.filter(item => item.length >= 2).reduce((result, item) => result.split(item).join('a model'), text);
export const clamp = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, max - 1)}…`;
/** Toast message text: redacted, then clamped to the SDK's 500 chars. */
export const toastText = (text: string, forbidden: readonly string[]): string => clamp(redact(text, forbidden), TOAST_MAX_CHARS);
