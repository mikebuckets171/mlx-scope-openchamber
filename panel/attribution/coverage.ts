import type { SnapshotV2 } from '../../src/contract/snapshot.ts';

// Owner: attribution. What this frame's own polls saw of the runtime: request counts at each reading and whether the
// readings form one unbroken stretch (auto-rule conditions 4 and 7). Memory only; nothing here is sent or stored.

/** Plan §4.3: a gap longer than 2.5× the cadence is a segment break. */
export const SEGMENT_BREAK_FACTOR = 2.5;
/** The Bionic `lms` stream idle-stops after 60 s (plan §4.4); a longer gap may hide a restart. */
export const STREAM_GAP_MS = 60_000;
const SAMPLE_LIMIT = 3_000;
const SAMPLE_AGE_MS = 1_200_000;             // REPLY_LIMIT_MS and then some
const AVAILABLE = new Set(['ready', 'degraded']);

interface Sample {
  at: number;
  active: number | null;                     // null: the runtime cannot count requests
  cadenceMs: number;
  key: string | null;                        // service instance, connection and generation; null = no usable reading
  stream: boolean;                           // completions come from a runtime event stream (`reported`)
}

export class ActivityTrack {
  private samples: Sample[] = [];

  /**
   * One poll. `null` (a failed poll) and an unavailable runtime break the stretch. `cadenceMs` is the frame's own
   * delay when it polls slower than `nextPollMs` (energy saving); the larger of the two sets the break threshold.
   */
  observe(body: SnapshotV2 | null, at: number, cadenceMs = 0): void {
    if (!body) { this.break(at); return; }
    const healthy = AVAILABLE.has(body.status.state), sampled = body.runtime.sampledAt ?? body.serverNow;
    const key = healthy ? `${body.service.instance}\u0000${body.connection.id}\u0000${body.connection.generation}` : null;
    const last = this.samples.at(-1);
    // A reading the scheduler served from its cache is the same sample; an older one adds nothing.
    if (last && (sampled < last.at || sampled === last.at && last.key === key)) return;
    this.push({ at: sampled, key, cadenceMs: Math.max(cadenceMs, body.nextPollMs),
      active: body.capabilities['server.requests'] ? body.runtime.server.active : null,
      stream: body.capabilities['server.completions']?.basis === 'reported' });
  }

  /** The frame stopped looking (hidden, paused): whatever happens next is not continuous with what came before. */
  break(at: number): void { this.push({ at: Math.max(at, this.latest() ?? at), active: null, cadenceMs: 0, key: null, stream: false }); }

  reset(): void { this.samples = []; }

  /** The newest reading's time, or null before the first. */
  latest(): number | null { return this.samples.at(-1)?.at ?? null; }

  /** One unbroken stretch of usable readings runs from at or before `from` to at or after `to`. */
  covered(from: number, to: number): boolean {
    const samples = this.samples;
    let index = samples.length - 1;
    while (index >= 0 && samples[index]!.at > from) index -= 1;
    if (index < 0) return false;
    for (; index < samples.length; index += 1) {
      const sample = samples[index]!, next = samples[index + 1];
      if (sample.key === null) return false;
      if (sample.at >= to) return true;
      if (!next || !continuous(sample, next)) return false;
    }
    return false;
  }

  /** The most requests any usable reading in [from, to] saw; null when one of them could not count. */
  activeMax(from: number, to: number): number | null {
    let max = 0;
    for (const sample of this.samples) {
      if (sample.at < from || sample.at > to || sample.key === null) continue;
      if (sample.active === null) return null;
      max = Math.max(max, sample.active);
    }
    return max;
  }

  /**
   * The last reading before `at` that saw no request running, when every reading after it up to `at` saw one: a request
   * that finished at `at` without a reported start began after this. Null when unknown.
   */
  idleBefore(at: number): number | null {
    for (let index = this.samples.length - 1; index >= 0; index -= 1) {
      const sample = this.samples[index]!;
      if (sample.at >= at) continue;
      if (sample.key === null || sample.active === null) return null;
      if (sample.active === 0) return sample.at;
    }
    return null;
  }

  private push(sample: Sample): void {
    this.samples.push(sample);
    const oldest = sample.at - SAMPLE_AGE_MS;
    let drop = Math.max(0, this.samples.length - SAMPLE_LIMIT);
    while (drop < this.samples.length && this.samples[drop]!.at < oldest) drop += 1;
    if (drop) this.samples.splice(0, drop);
  }
}

const continuous = (a: Sample, b: Sample): boolean => a.key !== null && a.key === b.key
  && (b.at - a.at <= SEGMENT_BREAK_FACTOR * a.cadenceMs || a.stream && b.stream && b.at - a.at <= STREAM_GAP_MS);
