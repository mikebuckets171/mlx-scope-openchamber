import type { AttachIssueRequest } from '@openchamber/sdk';
import { arr as list, nonneg, obj, oneOf, type Json } from '../../src/contract/guards.ts';
import { runtimeNames, runtimeKind } from '../../src/contract/runtime.ts';
import { CONTRACT_VERSION } from '../../src/contract/version.ts';
import type { VsUsual } from '../history/regress.ts';
import { clamp, redact } from './sanitize.ts';

// Owner: scope-flip. The `/scope` text (plan §5.8), re-exported by report.ts. Imported directly by the background frame,
// which must stay under 25 KB with the SDK client (about 17 KB) inside it.

export const SCOPE_TEXT_MAX_CHARS = 16_000;
export const SCOPE_HEADER = "Sent to this chat's model, which may be a cloud provider";

/**
 * The `/scope` diagnostics body (plan §5.8). `snapshot` is a `/v2/snapshot` body, raw or already parsed: this reads it
 * through its own allowlist (the background bundle cannot carry `parseSnapshotV2` under 25 KB) and copies no string
 * from it except enum codes. A value shows only with its capability, and every value names its basis (P3).
 * `vsUsual`: the last reply's deltas; `null` when local history could not be read; omitted, no line.
 */
export interface ScopeTextInput { version: string; now: number; snapshot: unknown; vsUsual?: readonly VsUsual[] | null }

const BASES = ['reported', 'derived', 'observed', 'last-observed', 'estimate'];
const PRESSURE = ['', 'normal', 'warning', '', 'critical'];
const THERMAL = ['nominal', 'moderate', 'heavy', 'trapping', 'sleeping'];
const METRICS: Record<string, string> = { decodeTps: 'decode', prefillTps: 'prefill', ttftMs: 'first token' };

const round = (value: number, digits = 1): string => String(+value.toFixed(digits));
const secs = (ms: number): string => ms < 1_000 ? `${Math.round(ms)} ms` : `${round(ms / 1000, 2)} s`;
const pct = (value: number): string => `${Math.round(value * 100)}%`;
/** The ledger's size buckets (<8k, 8–32k, 32–64k, 64–128k, >128k tokens); ledger-schema.ts sizeBucket, pinned by a test. */
export const sizeBucket = (tokens: number | null): number | null => tokens === null ? null : [8_192, 32_768, 65_536, 131_072, Infinity].findIndex(top => tokens < top);
/** Context sizes as buckets, never the exact count. */
const bucket = (tokens: number): string => `context ${['under 8k', '8k–32k', '32k–64k', '64k–128k', 'over 128k'][sizeBucket(tokens)!]} tokens`;
const at = (root: unknown, path: string): unknown => path.split('.').reduce<unknown>((value, key) => obj(value)?.[key], root);
const code = (value: unknown): string | null => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value) ? value : null;

const basisOf = oneOf(BASES);

/** Model names a body carries (class B): redacted from the text as a backstop, although nothing copies them. */
const modelNames = (body: unknown): unknown[] => ['runtime.request.model', 'compat.modelID', 'runtime.residency', 'runtime.catalog', 'completions.items',
  'alerts', 'alertLog'].flatMap(path => at(body, path) ?? []).map(item => {
    const object = obj(item);
    return object ? object.model ?? object.name ?? at(item, 'params.model') : item;
  });

/** The newest finished reply the body reports: a positive seq, a finish time and a basis, as parseCompletionV2 requires. */
export const lastReply = (body: unknown, reported: unknown = true): Json | null => reported
  ? list(at(body, 'completions.items')).map(obj).reverse().find(item => (nonneg(item?.seq) ?? 0) > 0 && nonneg(item?.finishedAt) !== null
    && basisOf(item?.basis) && typeof item?.overlapped === 'boolean') ?? null : null;

const scopeLines = (body: Json, vsUsual: readonly VsUsual[] | null | undefined, now: number): string[] => {
  const lines: string[] = [];
  const capabilities = obj(body.capabilities), basis = (key: string): string | null => basisOf(obj(capabilities?.[key])?.basis);
  /** A non-negative number at most `most`, only when its capability is declared. */
  const value = (root: unknown, path: string, key: string, most = Infinity): number | null => {
    const n = basis(key) ? nonneg(at(root, path)) : null;
    return n !== null && n <= most ? n : null;
  };
  const tagged = (text: string, key: string): string => `${text} (${basis(key)})`;
  const rate = (name: string, root: unknown, path: string, key: string): string | false => {
    const n = value(root, path, key);
    return n !== null && tagged(`${name} ${round(n)} tok/s`, key);
  };
  const line = (label: string, parts: unknown[]): void => {
    const text = parts.filter(Boolean).join(', ');
    if (text) lines.push(`${label}: ${text}`);
  };

  const serverNow = nonneg(body.serverNow) ?? now, connection = obj(body.connection), runtime = runtimeKind(connection?.runtime);
  const standalone = runtime === 'splash';
  const version = connection?.version, splash = connection?.engine === 'splash', bionic = connection?.host === 'bionic';
  const runtimeBody = obj(body.runtime), status = obj(body.status);
  const phase = code(runtimeBody?.phase) ?? 'unknown', reason = code(status?.reason), state = code(status?.state) ?? 'unknown';
  const sampledAt = nonneg(runtimeBody?.sampledAt) ?? serverNow;
  line('Runtime', [runtime === 'lmstudio' && (splash || bionic) ? `${splash ? 'Splash via ' : ''}${bionic ? 'Bionic' : 'LM Studio'}`
    : runtime ? runtimeNames[runtime] : 'unknown', typeof version === 'string' && /^[\w.+-]{1,40}$/.test(version) && `version ${version}`,
  `status ${state}${reason ? ` (${reason})` : ''}`, `phase ${phase}`,
  `reading ${secs(Math.max(0, serverNow - sampledAt))} old`]);

  // The current request, with parseSnapshotV2's cross-field rules: progress only in prefill, an estimate only while it moves.
  const request = obj(runtimeBody?.request), PROGRESS = 'request.prefillProgress', PREFILL = 'request.prefillRate';
  if (request) {
    const done = nonneg(request.prefillProcessedTokens), total = nonneg(request.prefillTotalTokens), stale = request.prefillStale === true;
    // Counts, when sent, decide progress; a fraction without valid counts is not trusted.
    const counted = request.prefillProcessedTokens != null || request.prefillTotalTokens != null
      ? done !== null && total && done <= total ? done / total : null : value(request, 'prefillFraction', PROGRESS, 1);
    const progress = phase === 'prefill' && basis(PROGRESS) ? counted : null, prefill = value(request, 'prefillTps', PREFILL);
    const eta = progress !== null && progress < 1 && !stale && prefill ? value(request, 'prefillEtaMs', 'request.prefillEta') : null;
    const context = value(request, 'contextUsedTokens', 'request.context') ?? value(request, 'promptTokens', 'request.tokens');
    const ttft = value(request, 'ttftMs', 'request.ttft');
    line('Current request', [rate('decode', request, 'decodeTps', 'request.decodeRate'), !stale && rate('prefill', request, 'prefillTps', PREFILL),
      progress !== null && tagged(`prefill ${pct(progress)} of this stage${stale ? ', held' : ''}`, PROGRESS),
      eta !== null && `about ${secs(eta)} left (runtime estimate)`, ttft !== null && tagged(`first token ${secs(ttft)}`, 'request.ttft'),
      context !== null && bucket(context)]);
  }

  const server = runtimeBody?.server, REQUESTS = 'server.requests', AVERAGES = 'server.averages', LATENCY = 'server.latency', RATES = 'server.rates';
  const active = value(server, 'active', REQUESTS), queued = value(server, 'queued', REQUESTS), window = value(server, 'rates.windowMs', RATES);
  const promptWindow = value(server, 'rates.promptWindowMs', RATES) ?? (at(server, 'rates.decodeTps') === undefined ? window : null);
  // A recent value always takes its own interval and guards; an unavailable interval never selects an average.
  const speed = (prefill: boolean, recent: boolean) => {
    const stage = prefill ? 'prefill' : 'decode', interval = prefill ? promptWindow : window;
    return (!recent || interval !== null && (!standalone || basis(RATES) === 'derived' && interval >= 2000 && interval <= 5000 && active
      && (phase === stage || phase === 'processing') && state === 'ready' && status?.reason === null
      && Math.max(serverNow, now) - sampledAt <= Math.max(6000, 2 * (nonneg(body.nextPollMs) ?? 2000) + 1000)))
      && rate(recent ? standalone ? `recent ${prefill ? stage + ' ' : ''}engine speed over ${secs(interval!)} (${prefill ? 'input' : 'output'}/native ${stage} time)`
        : `decode over ${secs(interval!)}` : standalone ? `${prefill ? stage + ' ' : ''}average since engine start` : `average ${stage}`,
      server, `${recent ? 'rates' : 'averages'}.${prefill && recent ? 'prompt' : stage}Tps`, recent ? RATES : AVERAGES);
  };
  const ttft = basis(LATENCY) ? obj(at(server, 'histograms.ttftMs')) : null, p50 = nonneg(ttft?.p50), p95 = nonneg(ttft?.p95);
  // null counts are "cannot count", so they are left out rather than shown as a number.
  line('Server, all requests', [(active ?? queued) !== null && tagged([active !== null && `${active} active`, queued !== null && `${queued} queued`]
    .filter(Boolean).join(', '), REQUESTS),
    speed(false, false), speed(true, false),
    p50 !== null && p95 !== null && p50 <= p95 && ttft?.window === 'native-last-4096'
      && tagged(`first token p50 ${secs(p50)} p95 ${secs(p95)} over ${nonneg(ttft.n)} requests`, LATENCY),
    speed(false, true), standalone && speed(true, true)]);

  const last = lastReply(body, basis('server.completions'));
  if (last) {
    const n = (key: string): number | null => nonneg(last[key]), prompt = n('promptTokens'), cached = n('cachedTokens'), verdict = obj(last.verdict);
    const decode = n('decodeTps'), prefill = n('prefillTps'), first = n('ttftMs'), attr = code(verdict?.attr);
    line(`Last finished reply (${secs(Math.max(0, serverNow - n('finishedAt')!))} ago, ${last.basis})`, [
      decode !== null && `decode ${round(decode)} tok/s`, prefill !== null && `prefill ${round(prefill)} tok/s`, first !== null && `first token ${secs(first)}`,
      prompt !== null && bucket(prompt), prompt && cached !== null && cached <= prompt && `${pct(cached / prompt)} cached`,
      (last.overlapped === true || (n('aggregateOf') ?? 0) > 1) && 'may mix several requests']);
    line('Label', [attr === 'inferred' ? 'inferred for Scope’s chat at sampling time' : attr === 'armed' ? 'armed Next reply'
      : `server-wide (${attr === 'withheld' && code(verdict?.reason) || 'not labelled'})`]);
    if (vsUsual !== undefined) line('vs usual', [vsUsual === null ? 'history unavailable'
      : vsUsual.filter(item => METRICS[item.metric] && item.ratio > 0 && item.n >= 5)
        .map(item => `${METRICS[item.metric]} ${round(item.ratio, 2)}× (n=${item.n})`).join(', ') || 'no baseline yet']);
  }

  const host = at(body, 'host'), level = value(host, 'mac.pressureLevel', 'host.pressure', 4), thermal = value(host, 'thermal.level', 'host.thermal', 4);
  const alloc = value(host, 'gpu.allocBytes', 'host.gpuMemory'), busy = value(host, 'gpu.busyFraction', 'host.gpuBusy', 1);
  line('This Mac', [level !== null && PRESSURE[level] && `memory pressure ${PRESSURE[level]}`, busy !== null && `GPU ${pct(busy)} busy`,
    alloc !== null && `GPU memory ${round(alloc / 1024 ** 3)} GiB allocated (includes other apps, not model size)`,
    (busy ?? alloc) !== null && 'GPU values driver-reported', thermal !== null && THERMAL[thermal] && `thermal pressure ${THERMAL[thermal]}`]);
  line('Alerts', [list(body.alerts).map(item => code(obj(item)?.id)).filter(Boolean).join(', ') || 'none']);
  return lines;
};

export const scopeText = (input: ScopeTextInput): string => {
  const body = obj(input.snapshot);
  // Only numbers, enum codes and the runtime version are copied, so no class A value can reach the text (canary tests).
  const usable = body?.contractVersion === CONTRACT_VERSION ? body : null;
  const lines = [`${SCOPE_HEADER}.`,
    `MLX Scope ${input.version}: local server/Mac; replies labelled separately. No chat content, model names, paths or IDs.`, '',
    ...usable ? scopeLines(usable, input.vsUsual, input.now) : ['No runtime reading.']];
  return clamp(redact(lines.join('\n'), usable ? modelNames(usable).filter(name => typeof name === 'string') as string[] : []), SCOPE_TEXT_MAX_CHARS);
};
/** `version`'s README: releases link their tag, prereleases `main` (the connection-help.ts link rule). */
export const scopeReadme = (version: string): string =>
  `https://github.com/mikebuckets171/mlx-scope-openchamber/blob/${version.includes('-') ? 'main' : `v${version}`}/README.md#scope-diagnostics`;
export const scopeItem = (text: string, readmeUrl: string): AttachIssueRequest =>
  ({ providerId: 'mlx-scope', id: 'mlx-scope-diagnostics', title: 'MLX Scope diagnostics', url: readmeUrl, text: clamp(text, SCOPE_TEXT_MAX_CHARS) });
