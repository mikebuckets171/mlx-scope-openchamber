import { expect, test } from 'bun:test';
import { parseAlertLog, parseAlerts } from '../../src/contract/alerts.ts';
import type { HostV2 } from '../../src/contract/host.ts';
import type { StatusV2 } from '../../src/contract/snapshot.ts';
import { ALERT_RULES, AlertBook, GIB, SWAP_GROWTH, TOAST_FRESH_MS, ToastLimiter, type AlertInput } from './alerts.ts';

const T = 1_790_690_700_000, S = 1_000, MIN = 60_000;
const ready: StatusV2 = { state: 'ready', reason: null, params: {} };
const unreachable: StatusV2 = { state: 'failing', reason: 'runtime_unreachable', params: { port: 8001 } };
const input = (at: number, patch: Partial<AlertInput> = {}): AlertInput =>
  ({ at, status: ready, phase: 'idle', loadedModels: 1, host: null, covered: true, runtime: 'omlx', ...patch });
const mac = (at: number, pressureLevel: 1 | 2 | 4, swapUsedBytes = GIB): HostV2 => ({ sampledAt: at, mac: { sampledAt: at, pressureLevel, swapUsedBytes } });
const ids = (book: AlertBook, now: number, key?: string): string[] => book.view(false, now, key).alerts.map(alert => alert.id);

test('pressure: warning after a 10 s dwell, critical at once and superseding it, each ending 30 s after it clears', () => {
  const book = new AlertBook();
  const table: Array<[seconds: number, level: 1 | 2 | 4, active: string[]]> = [
    [0, 1, []], [10, 2, []], [15, 2, []], [20, 2, ['pressure-warning']], [30, 4, ['pressure-critical']], [40, 2, ['pressure-critical']],
    [69, 2, ['pressure-critical']], [70, 2, []], [80, 2, ['pressure-warning']], [90, 1, ['pressure-warning']], [119, 1, ['pressure-warning']], [120, 1, []],
  ];
  for (const [seconds, level, active] of table) {
    book.evaluate(input(T + seconds * S, { host: mac(T + seconds * S, level), covered: seconds > 0 }));
    expect(ids(book, T + seconds * S), `${seconds} s`).toEqual(active);
  }
  const { alertLog } = book.view(false, T + 120 * S);
  expect(alertLog).toEqual([
    { id: 'pressure-warning', severity: 'warning', since: T + 70 * S, until: T + 90 * S, params: { level: 2 } },
    { id: 'pressure-critical', severity: 'critical', since: T + 30 * S, until: T + 40 * S, params: { level: 4 } },
    { id: 'pressure-warning', severity: 'warning', since: T + 10 * S, until: T + 30 * S, params: { level: 2 } },
  ]);
  expect(parseAlertLog(structuredClone(alertLog))).toEqual(alertLog);
});

test('a gap ends open alerts at the last reading, and a dwell never spans it', () => {
  const book = new AlertBook();
  for (const seconds of [0, 10, 20, 25]) book.evaluate(input(T + seconds * S, { host: mac(T + seconds * S, 2), covered: seconds > 0 }));
  expect(ids(book, T + 25 * S)).toEqual(['pressure-warning']);
  book.evaluate(input(T + 300 * S, { host: mac(T + 300 * S, 2), covered: false }));
  expect(ids(book, T + 300 * S)).toEqual([]);
  expect(book.view(false, T + 300 * S).alertLog[0]).toMatchObject({ since: T, until: T + 25 * S });
  book.evaluate(input(T + 305 * S, { host: mac(T + 305 * S, 2) }));
  expect(ids(book, T + 305 * S)).toEqual([]);
  book.evaluate(input(T + 310 * S, { host: mac(T + 310 * S, 2) }));
  expect(book.view(false, T + 310 * S).alerts).toMatchObject([{ id: 'pressure-warning', since: T + 300 * S }]);
  // Another slot's recent reading keeps the host timeline: its new segment is not a host gap.
  book.evaluate(input(T + 320 * S, { host: mac(T + 320 * S, 2), covered: false, key: 'other' }));
  expect(ids(book, T + 320 * S)).toEqual(['pressure-warning']);
});

/** Host readings every 10 s from `from` to `to` s, none inside `pause`, with swap in GiB from `swap(seconds)`. */
const swapRun = (book: AlertBook, from: number, to: number, swap: (seconds: number) => number, pause: [number, number] = [Infinity, Infinity]) => {
  for (let seconds = from; seconds <= to; seconds += 10) {
    if (seconds >= pause[0] && seconds < pause[1]) continue;
    book.evaluate(input(T + seconds * S, { host: mac(T + seconds * S, 1, Math.round(swap(seconds) * GIB)), covered: seconds > from && seconds !== pause[1] }));
  }
};
const rising = (seconds: number) => 1 + Math.min(1.2, Math.max(0, (seconds - 60) / 60 * 1.2));

test('swap growth: +1 GiB within 5 min, only once one segment covers 80 % of the window; under 0.5 GiB for a minute ends it', () => {
  const book = new AlertBook();
  swapRun(book, 0, 230, rising);
  expect(ids(book, T + 230 * S)).toEqual([]);
  swapRun(book, 240, 240, rising);
  expect(book.view(false, T + 240 * S).alerts).toEqual([{ id: 'swap-growth', severity: 'info', since: T + 240 * S,
    params: { deltaBytes: Math.round(2.2 * GIB) - GIB, windowMs: SWAP_GROWTH.coverage * SWAP_GROWTH.windowMs }, badge: true }]);
  swapRun(book, 250, 390, rising);
  expect(ids(book, T + 390 * S)).toEqual(['swap-growth']);
  swapRun(book, 400, 450, rising);
  expect(ids(book, T + 450 * S)).toEqual(['swap-growth']);
  swapRun(book, 460, 460, rising);
  expect(ids(book, T + 460 * S)).toEqual([]);
  expect(book.view(false, T + 460 * S).alertLog[0]).toMatchObject({ id: 'swap-growth', since: T + 240 * S, until: T + 400 * S,
    params: { deltaBytes: Math.round(2.2 * GIB) - GIB, windowMs: 240_000 } });
});

test('swap growth that crosses a gap never alerts: the window starts again after it', () => {
  const book = new AlertBook();
  // Scope was closed from 70 s to 130 s, while swap rose.
  swapRun(book, 0, 600, rising, [70, 130]);
  expect(book.view(false, T + 600 * S).alertLog).toEqual([]);
  // The same growth seen whole in one segment does.
  const whole = new AlertBook();
  swapRun(whole, 0, 600, rising);
  expect(whole.view(false, T + 600 * S).alertLog.map(entry => entry.id)).toEqual(['swap-growth']);
});

test('thermal warns from level 2 and keeps the highest level; the GPU never alerts', () => {
  const book = new AlertBook();
  const thermal = (seconds: number, level: 0 | 1 | 2 | 3 | 4): HostV2 => ({ sampledAt: T + seconds * S, thermal: { sampledAt: T + seconds * S, level },
    gpu: { sampledAt: T + seconds * S, busyFraction: 1, allocBytes: 64 * GIB, inUseBytes: 64 * GIB }, mac: { sampledAt: T + seconds * S, pressureLevel: 1, wiredLimitBytes: GIB, swapUsedBytes: 0 } });
  for (const [seconds, level] of [[0, 1], [60, 2], [120, 3], [180, 1], [239, 1]] as const) book.evaluate(input(T + seconds * S, { host: thermal(seconds, level), covered: seconds > 0 }));
  expect(book.view(false, T + 239 * S).alerts).toEqual([{ id: 'thermal', severity: 'warning', since: T + 60 * S, params: { level: 3 }, badge: true }]);
  book.evaluate(input(T + 240 * S, { host: thermal(240, 1) }));
  expect(book.view(false, T + 240 * S)).toMatchObject({ alerts: [], alertLog: [{ id: 'thermal', until: T + 180 * S }] });
  expect(Object.keys(ALERT_RULES)).not.toContain('near-gpu-limit');
});

test('runtime lost: only after the runtime was seen answering, after a 5 s dwell; toast once per episode, for the leader only', () => {
  const book = new AlertBook();
  for (const seconds of [0, 3, 6, 10]) book.evaluate(input(T + seconds * S, { key: 'cold', status: unreachable, loadedModels: null }));
  expect(ids(book, T + 10 * S, 'cold')).toEqual([]);
  const run = (seconds: number, status: StatusV2) => book.evaluate(input(T + seconds * S, { key: 'omlx', status, loadedModels: status === ready ? 1 : null }));
  run(0, ready); run(1, unreachable); run(3, unreachable);
  expect(ids(book, T + 3 * S, 'omlx')).toEqual([]);
  run(6, unreachable);
  expect(book.view(false, T + 6 * S, 'omlx').alerts).toEqual([{ id: 'runtime-lost', severity: 'critical', since: T + S, params: { runtime: 'omlx' }, badge: true }]);
  expect(book.view(true, T + 6 * S, 'omlx').alerts[0]!.toastSeq).toBe(1);
  expect(book.view(true, T + 7 * S, 'omlx').alerts[0]!.toastSeq).toBe(1);
  expect(book.view(false, T + 7 * S, 'omlx').alerts[0]).not.toHaveProperty('toastSeq');
  run(10, ready);
  expect(ids(book, T + 10 * S, 'omlx')).toEqual([]);
  run(100, unreachable); run(106, unreachable);
  expect(book.view(true, T + 106 * S, 'omlx').alerts[0]).toMatchObject({ since: T + 100 * S, toastSeq: 2 });
  // Runtime alerts belong to their slot; the log is the service's.
  expect(ids(book, T + 106 * S, 'splash')).toEqual([]);
  expect(book.view(false, T + 106 * S, 'splash').alertLog.map(entry => [entry.id, entry.until])).toEqual([['runtime-lost', null], ['runtime-lost', T + 10 * S]]);
});

test('model unloaded: a drop to 0 names the model in view, a load clears it, and its toast waits 30 min', () => {
  const book = new AlertBook(), model = 'Example-27B-4bit';
  const run = (seconds: number, loadedModels: number | null, patch: Partial<AlertInput> = {}) =>
    book.evaluate(input(T + seconds * S, { loadedModels, model: loadedModels ? model : null, ...patch }));
  run(0, 1); run(2, 0);
  expect(book.view(true, T + 2 * S).alerts).toEqual([{ id: 'model-unloaded', severity: 'info', since: T + 2 * S, params: { model }, badge: true, toastSeq: 1 }]);
  run(4, null); run(6, 0);
  expect(ids(book, T + 6 * S)).toEqual(['model-unloaded']);
  run(8, 1);
  expect(ids(book, T + 8 * S)).toEqual([]);
  run(200, 0);
  expect(book.view(true, T + 200 * S).alerts[0]).not.toHaveProperty('toastSeq');
  // A restart is not an unload, and neither is a drop the view did not see.
  run(300, 1); run(302, null, { status: unreachable }); run(304, 0);
  run(400, 1); run(500, 0, { covered: false });
  expect(ids(book, T + 500 * S)).toEqual([]);
});

test('Splash recovering, the oMLX prefill stall and memory guard show in view only: no badge, no toast', () => {
  const book = new AlertBook();
  const recovering: StatusV2 = { state: 'recovering', reason: 'recovering', params: { retryInMs: 30_000, crashTrace: true } };
  book.evaluate(input(T, { key: 'splash', runtime: 'splash', status: recovering }));
  expect(book.view(true, T, 'splash').alerts).toEqual([{ id: 'splash-recovering', severity: 'warning', since: T, params: { retryInMs: 30_000, crashTrace: true }, badge: false }]);
  const stall = (seconds: number, patch: Partial<AlertInput> = {}) =>
    book.evaluate(input(T + seconds * S, { phase: 'prefill', request: { prefillStale: true }, ...patch }));
  stall(0); stall(29);
  expect(ids(book, T + 29 * S)).toEqual([]);
  stall(30);
  expect(book.view(true, T + 45 * S).alerts).toEqual([{ id: 'omlx-prefill-stall', severity: 'warning', since: T, params: { stalledMs: 45_000 }, badge: false }]);
  stall(50, { request: { prefillStale: false } });
  expect(book.view(false, T + 60 * S).alertLog.find(entry => entry.id === 'omlx-prefill-stall')).toMatchObject({ until: T + 50 * S, params: { stalledMs: 50_000 } });
  const other = new AlertBook();
  for (const seconds of [0, 40]) other.evaluate(input(T + seconds * S, { runtime: 'vllm-mlx', phase: 'prefill', request: { prefillStale: true }, guardLevel: 3 }));
  expect(ids(other, T + 40 * S)).toEqual([]);
  book.evaluate(input(T + 60 * S, { guardLevel: 2 }));
  expect(book.view(true, T + 60 * S).alerts).toEqual([{ id: 'omlx-memory-guard', severity: 'warning', since: T + 60 * S, params: {}, badge: false }]);
  book.evaluate(input(T + 65 * S, { guardLevel: 1 }));
  expect(ids(book, T + 65 * S)).toEqual(['omlx-memory-guard']);
  book.evaluate(input(T + 75 * S, { guardLevel: 1 }));
  expect(ids(book, T + 75 * S)).toEqual([]);
});

test('toasts: ≤ 1 a minute and ≤ 3 an hour service-wide, critical first, never late, and never retried', () => {
  const limiter = new ToastLimiter();
  expect([0, 30, 60, 120, 200, 3_600, 3_661].map(seconds => limiter.allow(T + seconds * S))).toEqual([true, false, true, true, false, true, true]);
  const book = new AlertBook();
  // Critical pressure and swap growth start together: the one toast of that minute goes to critical.
  swapRun(book, 0, 230, rising);
  book.evaluate(input(T + 240 * S, { host: mac(T + 240 * S, 4, Math.round(2.2 * GIB)) }));
  expect(book.view(true, T + 240 * S).alerts.map(alert => [alert.id, alert.toastSeq])).toEqual([['pressure-critical', 1], ['swap-growth', undefined]]);
  // Still no toast for it once the minute has passed: a toast is decided once per episode.
  expect(book.view(true, T + 320 * S).alerts.map(alert => alert.toastSeq)).toEqual([1, undefined]);
  // A leader that first sees an alert more than a minute after it started gets no toast.
  const late = new AlertBook();
  late.evaluate(input(T, { host: { sampledAt: T, thermal: { sampledAt: T, level: 2 } } }));
  expect(late.view(false, T).alerts).toHaveLength(1);
  expect(late.view(true, T + TOAST_FRESH_MS + 1).alerts[0]).not.toHaveProperty('toastSeq');
});

test('the log keeps the newest 20 episodes, open ones included, and every body parses', () => {
  const book = new AlertBook();
  // 25 guard episodes of 10 s, 30 s apart, then one still open.
  for (let index = 0; index < 25; index += 1) for (const [offset, guardLevel] of [[0, 2], [10, 0], [20, 0]] as const) {
    book.evaluate(input(T + (index * 30 + offset) * S, { guardLevel }));
  }
  book.evaluate(input(T + 750 * S, { guardLevel: 3 }));
  const view = book.view(true, T + 750 * S);
  expect(view.alertLog).toHaveLength(20);
  expect(view.alertLog[0]).toMatchObject({ since: T + 750 * S, until: null });
  expect(view.alertLog[1]).toMatchObject({ since: T + 720 * S, until: T + 730 * S });
  expect(view.alertLog.at(-1)!.since).toBe(T + 180 * S);
  expect(parseAlerts(structuredClone(view.alerts))).toEqual(view.alerts);
  expect(parseAlertLog(structuredClone(view.alertLog))).toEqual(view.alertLog);
});
