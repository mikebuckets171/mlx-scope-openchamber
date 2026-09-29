import { randomUUID } from 'node:crypto';
import type { Surface } from '../../src/contract/snapshot.ts';
import { backoffMs, failuresOf, initialSlot, stepSlot, type SlotEvent, type SlotState } from './slot.ts';

export const SLOT_CAPACITY = 8;
/** No runtime is read more often than this, whatever its cadence. */
export const FLOOR_MS = 450;

export interface Slot<C, T> {
  readonly key: string;
  readonly fingerprint: string;
  readonly generation: number;               // v2 connection generation: +1 for every slot the scheduler creates
  readonly marker: string;                   // the 1.x opaque generation
  readonly context: C;
  value: T | null;
  inFlight: Promise<T> | null;
  sampledAt: number;
  state: SlotState;
  activeAt: number;                          // last reading with work in progress, or creation
}
export interface Outcome { event: SlotEvent; active: boolean }

/**
 * Demand-driven reads, one slot per connection key: views share an in-flight collection, a reading younger than
 * the cadence (or still inside the backoff) is reused, and at most 8 slots are kept. Nothing runs without a caller.
 */
export class Scheduler<C, T> {
  private readonly slots = new Map<string, Slot<C, T>>();
  private generations = 0;
  constructor(private readonly monotonic: () => number, private readonly capacity = SLOT_CAPACITY) {}

  /**
   * The slot for `key`; a new fingerprint (endpoint, key, runtime) replaces it. Null when that would evict a read in
   * flight: an in-flight slot is never replaced, and a full table evicts only its oldest idle slot.
   */
  claim(key: string, fingerprint: string, context: () => C): Slot<C, T> | null {
    let slot = this.slots.get(key);
    if (slot && slot.fingerprint === fingerprint) return slot;
    const idleKey = [...this.slots].find(([, value]) => !value.inFlight)?.[0];
    if (slot?.inFlight || !slot && this.slots.size >= this.capacity && idleKey === undefined) return null;
    const at = this.monotonic();
    slot = { key, fingerprint, generation: ++this.generations, marker: randomUUID(), context: context(), value: null, inFlight: null,
      sampledAt: -Infinity, state: initialSlot(at), activeAt: at };
    this.slots.delete(key);
    if (this.slots.size >= this.capacity && idleKey !== undefined) this.slots.delete(idleKey);
    this.slots.set(key, slot);
    return slot;
  }

  /** `collect` must resolve (failures become readings); `outcome` classifies each reading for the slot machine. */
  read(slot: Slot<C, T>, cadenceMs: number, collect: () => Promise<T>, outcome: (value: T) => Outcome): Promise<T> {
    const now = this.monotonic();
    const fresh = slot.value !== null && (now - slot.sampledAt < Math.max(FLOOR_MS, cadenceMs) || now < slot.sampledAt + backoffMs(failuresOf(slot.state)));
    if (!slot.inFlight && !fresh) {
      slot.inFlight = collect().then(value => {
        const { event, active } = outcome(value);
        slot.value = value; slot.sampledAt = this.monotonic();
        slot.state = stepSlot(slot.state, event, slot.sampledAt);
        if (active) slot.activeAt = slot.sampledAt;
        return value;
      }).finally(() => { slot.inFlight = null; });
    }
    return slot.inFlight ?? Promise.resolve(slot.value!);
  }
}

// Frame cadence (plan §4.3). The frame applies its own Energy-saving floor.
export const POLL_MS = { active: 500, idle: 2_000, glanceActive: 1_000, glanceIdle: 3_000, glanceDormant: 10_000, yielded: 10_000 } as const;
export const DORMANT_AFTER_MS = 300_000;
export interface PollInput {
  surface?: Surface;
  active: boolean;                           // the reading shows work in progress
  idleMs: number;                            // since the slot last showed work
  failures: number;                          // consecutive failed collections
  hostLive: boolean;                         // a host reading is in the body
  yielded: boolean;                          // a higher-priority frame holds the lease
}
/** When the frame should poll next. */
export const nextPollMs = ({ surface, active, idleMs, failures, hostLive, yielded }: PollInput): number => {
  const glance = surface === 'status' || surface === 'background';
  const idle = glance ? idleMs >= DORMANT_AFTER_MS ? POLL_MS.glanceDormant : POLL_MS.glanceIdle : POLL_MS.idle;
  const cadence = active ? glance ? POLL_MS.glanceActive : POLL_MS.active : idle;
  // Host readings stay current while the runtime is down: the backoff never slows them past the idle cadence.
  const delay = failures > 0 ? hostLive ? Math.min(idle, backoffMs(failures)) : backoffMs(failures) : cadence;
  return yielded ? Math.max(POLL_MS.yielded, delay) : delay;
};
