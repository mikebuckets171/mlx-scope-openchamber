// The 3.2 motion system beside the digit roll (M2) and the media ring (M4). Every motion here is caused by a truthful
// change arriving — a block appearing (M1), a fresh measurement (M3), a phase, unit or label changing (M5) — and runs
// once. Nothing loops. A hidden or paused frame animates nothing, and Reduce Motion makes every change instant (M6).

const ARRIVE: Keyframe[] = [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }];
const CROSSFADE: Keyframe[] = [{ opacity: .35 }, { opacity: 1 }];
const BEAT: Keyframe[] = [{ transform: 'scale(1)' }, { transform: 'scale(1.24)', offset: .38 }, { transform: 'scale(1)' }];
const STAGGER_MS = 40;

export class Motion {
  private arrived = new WeakSet<Element>();
  private texts = new WeakMap<Element, string>();
  private beatKey: string | null = null;
  private readonly animations = new Set<Animation>();
  private readonly reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  constructor(private readonly root: HTMLElement) { this.reduced?.addEventListener('change', this.reset); }

  /**
   * After each render. `active`: the frame is visible and monitoring is not paused. `beat` identifies the fresh
   * measurement now shown live (the reading's own sample time), or null when nothing live is shown.
   */
  sync(active: boolean, beat: string | null): void {
    const still = !active || !!this.reduced?.matches;
    let order = 0;
    // M1: a block that appears fades in and rises 4 px once, staggered down the column; then it is still.
    for (const node of Array.from(this.root.querySelectorAll<HTMLElement>('[data-arrive]'))) {
      if (this.arrived.has(node)) continue;
      this.arrived.add(node);
      if (!still && this.shown(node)) this.run(node, ARRIVE, { duration: 120, delay: STAGGER_MS * order++, easing: 'ease-out', fill: 'backwards' });
    }
    // M5: a changed phase, unit or label crossfades; an unchanged one never moves.
    for (const node of Array.from(this.root.querySelectorAll<HTMLElement>('[data-crossfade]'))) {
      const text = node.textContent ?? '', before = this.texts.get(node);
      this.texts.set(node, text);
      if (!still && before !== undefined && before !== text && this.shown(node)) this.run(node, CROSSFADE, { duration: 120, easing: 'ease-out' });
    }
    // M3: the mark beats once per fresh measurement arrival, in any phase — the only recurring motion, caused by truth.
    if (beat === this.beatKey) return;
    this.beatKey = beat;
    if (beat === null || still) return;
    for (const mark of Array.from(this.root.querySelectorAll<HTMLElement>('[data-heartbeat]')))
      if (this.shown(mark)) this.run(mark, BEAT, { duration: 260, easing: 'cubic-bezier(.2,.7,.3,1)' });
  }
  private shown(node: HTMLElement): boolean { return typeof node.animate === 'function' && (node.checkVisibility?.() ?? true); }
  private run(node: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions): void {
    const animation = node.animate(frames, options);
    this.animations.add(animation);
    void animation.finished.catch(() => {}).finally(() => this.animations.delete(animation));
  }
  /** Stops every running motion; the next sync treats current blocks as already arrived. */
  readonly reset = (): void => {
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
  };
  dispose(): void { this.reset(); this.reduced?.removeEventListener('change', this.reset); }
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
