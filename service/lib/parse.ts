import { count, modelLabel as contractModelLabel } from '../../src/contract/guards.ts';

/** One set of value guards for runtime payloads, shared with the v2 contract parsers. */
export { count, nonneg, obj, type Json } from '../../src/contract/guards.ts';

/** A positive integer, such as a context limit; zero means "not reported" in every runtime payload Scope reads. */
export const positive = (value: unknown): number | null => { const n = count(value); return n !== null && n > 0 ? n : null; };
/** A model name, never a path: paths keep only their last segment. 160 characters is the 1.x display bound. */
export const modelLabel = (value: unknown, max = 160): string | null => contractModelLabel(value, max);
