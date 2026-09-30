import type { LeaseV2, Surface } from '../../src/contract/snapshot.ts';

export const LEASE_TTL_MS = 12_000;
export const LEASE_FRAMES = 16;
type Eligible = 'page' | 'panel' | 'status';
const PRIORITY: Record<Surface, number> = { page: 3, panel: 2, status: 1, background: 0 };
type Frame = { surface: Eligible; firstAt: number; seenAt: number };
export type LeaseView = LeaseV2 & { yielded: boolean };

/**
 * The one side-effect frame (P9), elected in memory among frames that polled within the TTL: page > panel > status.
 * A frame polls only while visible, so "polled recently" is "visible". Background frames and requests without a
 * frame id never lead. The leader keeps the lease against equal priority; `epoch` counts handovers.
 */
export class Lease {
  private readonly frames = new Map<string, Frame>();
  private leader: string | null = null;
  private epoch = 0;
  constructor(private readonly capacity = LEASE_FRAMES) {}

  /** Record a poll and return the lease as that frame sees it. `now` is a monotonic clock. */
  observe(frame: string | undefined, surface: Surface | undefined, now: number): LeaseView {
    for (const [id, item] of this.frames) if (now - item.seenAt >= LEASE_TTL_MS || now < item.seenAt) this.frames.delete(id);
    const eligible = surface === 'page' || surface === 'panel' || surface === 'status' ? surface : null;
    if (frame && eligible) {
      const known = this.frames.get(frame);
      if (!known && this.frames.size >= this.capacity) {
        const oldest = [...this.frames].filter(([id]) => id !== this.leader).sort(([, a], [, b]) => a.seenAt - b.seenAt)[0];
        if (oldest) this.frames.delete(oldest[0]);
      }
      if (known || this.frames.size < this.capacity) this.frames.set(frame, { surface: eligible, firstAt: known?.firstAt ?? now, seenAt: now });
    }
    this.elect();
    const leading = this.leader === null ? null : this.frames.get(this.leader)!.surface;
    return {
      leader: frame !== undefined && frame === this.leader, epoch: this.epoch, ttlMs: LEASE_TTL_MS, leaderSurface: leading,
      yielded: eligible !== null && frame !== this.leader && leading !== null && PRIORITY[leading] > PRIORITY[eligible],
    };
  }

  private elect(): void {
    const current = this.leader === null ? undefined : this.frames.get(this.leader);
    let best: [string, Frame] | null = null;
    for (const entry of this.frames) {
      const [, item] = entry;
      if (!best || PRIORITY[item.surface] > PRIORITY[best[1].surface] || PRIORITY[item.surface] === PRIORITY[best[1].surface] && item.firstAt < best[1].firstAt) best = entry;
    }
    if (current && (!best || PRIORITY[current.surface] >= PRIORITY[best[1].surface])) return;
    const next = best?.[0] ?? null;
    if (next !== null && next !== this.leader) this.epoch += 1;
    this.leader = next;
  }
}
