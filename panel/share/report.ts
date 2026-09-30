// Owner: scope-flip. The one sanitizer (P6) for every share path: Copy, Add to chat draft, /scope, toasts, baseline
// summary, capture.v2. Class A never; class B (model names) never in any of these sinks. The primitives live in
// sanitize.ts and the /scope text in scope.ts, so the background bundle does not carry the Copy report.

export { measurementReport } from '../report.ts';
export { clamp, redact, TOAST_MAX_CHARS, toastText } from './sanitize.ts';
export { lastReply, SCOPE_HEADER, SCOPE_TEXT_MAX_CHARS, scopeItem, scopeReadme, scopeText, type ScopeTextInput } from './scope.ts';
