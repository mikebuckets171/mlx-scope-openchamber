import type { AttachIssueRequest } from '@openchamber/sdk';

// Owner: scope-flip. The one sanitizer (P6) for every share path: Copy, Add to chat draft, /scope, toasts, baseline
// summary, capture.v2. Class A never; class B (model names) never in any of these sinks.

export { measurementReport } from '../report.ts';

export const TOAST_MAX_CHARS = 500;
export const SCOPE_TEXT_MAX_CHARS = 16_000;
export const SCOPE_HEADER = "Sent to this chat's model, which may be a cloud provider";

/** Replaces every occurrence of each forbidden string (model names, labels) with a neutral word. */
export const redact = (text: string, forbidden: readonly string[]): string =>
  forbidden.filter(item => item.length >= 2).reduce((result, item) => result.split(item).join('a model'), text);
export const clamp = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, max - 1)}…`;
/** Toast message text: redacted, then clamped to the SDK's 500 chars. */
export const toastText = (text: string, forbidden: readonly string[]): string => clamp(redact(text, forbidden), TOAST_MAX_CHARS);

/** The `/scope` diagnostics body (plan §5.8): runtime kind, phase, rates with basis, context bucket, baseline deltas with
 *  n, pressure/GPU/thermal and the attribution label; no model name. */
export interface ScopeTextInput { version: string; now: number; snapshot: unknown; label: string; baselineDeltas: readonly string[] }
export const scopeText = (input: ScopeTextInput): string => { void input; throw new Error('scopeText: not implemented (scope-flip)'); };
export const scopeItem = (text: string, readmeUrl: string): AttachIssueRequest =>
  ({ providerId: 'mlx-scope', id: 'mlx-scope-diagnostics', title: 'MLX Scope diagnostics', url: readmeUrl, text: clamp(text, SCOPE_TEXT_MAX_CHARS) });
