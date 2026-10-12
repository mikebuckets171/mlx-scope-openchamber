// The 3.2 motion system beside the digit roll (M2) and the media ring (M4). Every motion here is caused by a truthful
// change arriving — a block appearing (M1), a fresh measurement (M3), a phase, unit or label changing (M5) — and runs
// once. Nothing loops. A hidden or paused frame animates nothing, and Reduce Motion makes every change instant (M6).

const ARRIVE: Keyframe[] = [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }];
const CROSSFADE: Keyframe[] = [{ opacity: .35 }, { opacity: 1 }];
const BEAT: Keyframe[] = [{ transform: 'scale(1)' }, { transform: 'scale(1.24)', offset: .38 }, { transform: 'scale(1)' }];
const STAGGER_MS = 40;

export class Motion {
  #arrived = new WeakSet<Element>();
  #texts = new WeakMap<Element, string>();
  #beatKey: string | null = null;
  readonly #animations = new Set<Animation>();
  readonly #reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  readonly #root: HTMLElement;
  constructor(root: HTMLElement) { this.#root = root; this.#reduced?.addEventListener('change', this.reset); }

  /**
   * After each render. `active`: the frame is visible and monitoring is not paused. `beat` identifies the fresh
   * measurement now shown live (the reading's own sample time), or null when nothing live is shown.
   */
  sync(active: boolean, beat: string | null): void {
    const still = !active || !!this.#reduced?.matches;
    if (still) this.reset();
    const freshBeat = beat !== this.#beatKey;
    this.#beatKey = beat;
    const arrivals: HTMLElement[] = [], changes: HTMLElement[] = [], marks: HTMLElement[] = [];
    // Read visibility before starting any animation: animation writes must not make the next visibility read flush styles.
    // A nonempty crossfade key describes the visible label when its node also contains changing hidden explanation text.
    for (const node of Array.from(this.#root.querySelectorAll<HTMLElement>('[data-arrive], [data-crossfade], [data-heartbeat]'))) {
      const arrive = node.hasAttribute('data-arrive') && !this.#arrived.has(node);
      if (arrive) this.#arrived.add(node);
      let changed = false;
      if (node.hasAttribute('data-crossfade')) {
        const text = node.getAttribute('data-crossfade') || node.textContent || '', before = this.#texts.get(node);
        this.#texts.set(node, text);
        changed = before !== undefined && before !== text;
      }
      const mark = freshBeat && beat !== null && node.hasAttribute('data-heartbeat');
      if (still || !(arrive || changed || mark) || !this.#shown(node)) continue;
      if (arrive) arrivals.push(node);
      if (changed) changes.push(node);
      if (mark) marks.push(node);
    }
    // M1: a block that appears fades in and rises 4 px once, staggered down the column; then it is still.
    arrivals.forEach((node, order) => this.#run(node, ARRIVE, { duration: 120, delay: STAGGER_MS * order, easing: 'ease-out', fill: 'backwards' }));
    // M5: a changed phase, unit or label crossfades; an unchanged one never moves.
    for (const node of changes) this.#run(node, CROSSFADE, { duration: 120, easing: 'ease-out' });
    // M3: the mark beats once per fresh measurement arrival, in any phase — the only recurring motion, caused by truth.
    for (const mark of marks) this.#run(mark, BEAT, { duration: 260, easing: 'cubic-bezier(.2,.7,.3,1)' });
  }
  #shown(node: HTMLElement): boolean { return typeof node.animate === 'function' && (node.checkVisibility?.() ?? true); }
  #run(node: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions): void {
    const animation = node.animate(frames, options);
    this.#animations.add(animation);
    void animation.finished.catch(() => {}).finally(() => this.#animations.delete(animation));
  }
  /** Stops every running motion; the next sync treats current blocks as already arrived. */
  readonly reset = (): void => {
    for (const animation of this.#animations) animation.cancel();
    this.#animations.clear();
  };
  dispose(): void { this.reset(); this.#reduced?.removeEventListener('change', this.reset); }
}

type BeatSnapshot = { serverNow: number; runtime: { sampledAt?: number }; chat?: { observedAtMs: number; freshness: string } | null };
/**
 * The fresh measurement a frame shows live, by the reading's own sample time — never the poll's arrival. A live chat
 * observation keys by its observation time (a chat-only snapshot has no runtime sample); otherwise the runtime's sample,
 * which the contract dates to the snapshot itself when the runtime reports no separate sample time.
 */
export const beatKey = (root: HTMLElement, snapshot: BeatSnapshot | null): string | null =>
  !snapshot || !root.querySelector('[data-live="true"]') ? null
    : snapshot.chat?.freshness === 'live' ? `chat/${snapshot.chat.observedAtMs}` : `runtime/${snapshot.runtime.sampledAt ?? snapshot.serverNow}`;
