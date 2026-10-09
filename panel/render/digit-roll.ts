import { html, type Raw } from './html.ts';

/** The only animated states are two actual observations with identical display geometry. */
export const changedDigits = (before: string, after: string): number[] => {
  if (before.length !== after.length || before.replace(/\d/g, '#') !== after.replace(/\d/g, '#')) return [];
  return [...after].flatMap((char, index) => /\d/.test(char) && char !== before[index] ? [index] : []);
};
export const digitMarkup = (value: string): Raw => html`${[...value].map((char, index) =>
  html`<span class="digit-cell" data-digit="${index}" aria-hidden="true"><span class="digit-current">${char}</span></span>`)}`;

/** Motion is presentation-only: no interpolated number, timer, sampling or extra live announcement. */
export class DigitRoll {
  private previous = new Map<string, { value: string; context: string }>();
  private animations = new Set<Animation>();
  private readonly reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  constructor(private readonly root: HTMLElement) { this.reduced?.addEventListener('change', this.reset); }
  readonly reset = (): void => {
    for (const animation of this.animations) animation.cancel();
    this.animations.clear(); this.previous.clear();
    this.root.querySelectorAll('.digit-before').forEach(node => node.remove());
  };
  sync(context: string, visible: boolean): void {
    if (!visible || this.reduced?.matches) { this.reset(); return; }
    for (const animation of this.animations) animation.cancel();
    this.animations.clear(); this.root.querySelectorAll('.digit-before').forEach(node => node.remove());
    const next = new Map<string, { value: string; context: string }>();
    for (const node of Array.from(this.root.querySelectorAll<HTMLElement>('[data-roll-value]'))) {
      if (!node.closest('[data-live="true"]')) continue;
      const value = node.dataset.rollValue!, local = `${context}\0${node.dataset.rollContext ?? ''}`;
      const key = node.id, old = this.previous.get(key);
      next.set(key, { value, context: local });
      if (!old || old.context !== local) continue;
      for (const index of changedDigits(old.value, value)) {
        const cell = node.querySelector<HTMLElement>(`[data-digit="${index}"]`), current = cell?.querySelector<HTMLElement>('.digit-current');
        if (!cell || !current || typeof current.animate !== 'function') continue;
        cell.querySelector('.digit-before')?.remove();
        const previous = document.createElement('span'); previous.className = 'digit-before'; previous.textContent = old.value[index]!; previous.setAttribute('aria-hidden', 'true'); cell.append(previous);
        const animate = (element: HTMLElement, frames: Keyframe[]): void => {
          const animation = element.animate(frames, { duration: 160, easing: 'cubic-bezier(.2,.7,.2,1)' });
          this.animations.add(animation);
          void animation.finished.catch(() => {}).finally(() => { this.animations.delete(animation); if (element === previous) previous.remove(); });
        };
        animate(current, [{ transform: 'translateY(55%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }]);
        animate(previous, [{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(-55%)', opacity: 0 }]);
      }
    }
    this.previous = next;
  }
  dispose(): void { this.reset(); this.reduced?.removeEventListener('change', this.reset); }
}
