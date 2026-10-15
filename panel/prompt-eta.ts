import { linkIdentity, type Reading } from './present/reading.ts';

type Point = { at: number; done: number };
/** An in-memory estimate from existing prompt observations. No timer, collector, or saved data. */
export class PromptEta {
  #key = ''; #points: Point[] = []; #elapsed: number | undefined;
  ms: number | null = null;
  reset(): void { this.#key = ''; this.#points = []; this.#elapsed = undefined; this.ms = null; }
  observe(reading: Reading): void {
    const body = reading.body, request = reading.request;
    const done = request?.prefillProcessedTokens, total = request?.prefillTotalTokens;
    const at = request?.prefillObservedAt ?? reading.sampledAt;
    if (!body || body.status.state !== 'ready' || body.status.reason !== null || reading.phase !== 'prefill'
      || reading.active !== 1 || request?.prefillStale || !body.capabilities['request.prefillProgress']
      || done == null || total == null || !Number.isSafeInteger(done) || !Number.isSafeInteger(total)
      || done < 0 || total <= done || !Number.isFinite(at) || at > body.serverNow || body.serverNow - at > 6_000) {
      this.reset(); return;
    }
    const key = JSON.stringify([body.service.instance, reading.link && linkIdentity(reading.link), reading.model, total]);
    const last = this.#points.at(-1), elapsed = request?.elapsedMs;
    if (key !== this.#key || last && (at < last.at || done < last.done || at - last.at > 6_000
      || elapsed !== undefined && this.#elapsed !== undefined && elapsed < this.#elapsed)) this.reset();
    this.#key = key; this.#elapsed = elapsed;
    const previous = this.#points.at(-1);
    // Repeated source observations never create speed or advance a countdown.
    if (previous && (at === previous.at || done === previous.done)) {
      if (body.serverNow - previous.at >= 6_000 || at === previous.at && done !== previous.done) this.reset();
      return;
    }
    this.#points = [...this.#points.filter(point => at - point.at <= 30_000), { at, done }].slice(-8);
    const first = this.#points[0]!;
    this.ms = this.#points.length >= 3 && at - first.at >= 2_000
      ? (total - done) * (at - first.at) / (done - first.done) : null;
  }
}

/** Coarse units make uncertainty visible; an unfinished prompt never says zero seconds left. */
export const promptEtaText = (ms: number): string => {
  const seconds = ms / 1_000;
  const duration = seconds < 1 ? '<1 s' : seconds < 60 ? `${Math.ceil(seconds / 5) * 5} s`
    : seconds < 3_600 ? `${Math.ceil(seconds / 60)} min` : seconds < 86_400 ? `${Math.ceil(seconds / 3_600)} hr` : '>24 hr';
  return `Est. ${duration} left`;
};
