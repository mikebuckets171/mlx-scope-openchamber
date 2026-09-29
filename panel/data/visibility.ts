type Observer = Pick<IntersectionObserver, 'observe' | 'disconnect'>;
type ObserverFactory = (callback: (entries: Array<Pick<IntersectionObserverEntry, 'isIntersecting'>>) => void) => Observer;
type Frame = { readonly innerWidth: number; readonly innerHeight: number };
type Page = Pick<Document, 'hidden' | 'documentElement' | 'addEventListener' | 'removeEventListener'>;

const nativeObserver: ObserverFactory | null = typeof IntersectionObserver === 'function'
  ? callback => new IntersectionObserver(callback, { threshold: 0 }) : null;

/**
 * Whether anyone can see this frame. A hidden rail tab keeps `document.hidden` false and a 0×0 viewport, so
 * IntersectionObserver v1 decides; v2 `isVisible` reads false even for visible panels (SPIKES S1). The first estimate
 * is synchronous, so a visible frame polls at once and a `display:none` frame never starts.
 */
export class Visibility {
  private intersecting: boolean;
  private readonly observer: Observer | null;
  constructor(private readonly page: Page, frame: Frame, private readonly change: () => void, observe: ObserverFactory | null = nativeObserver) {
    this.intersecting = frame.innerWidth > 0 && frame.innerHeight > 0;
    this.observer = observe?.(entries => {
      const next = entries.at(-1)?.isIntersecting ?? this.intersecting;
      if (next === this.intersecting) return;
      this.intersecting = next;
      this.change();
    }) ?? null;
    this.observer?.observe(page.documentElement);
    // 1.6 re-synchronised on every visibility event, changed or not; that stays.
    page.addEventListener('visibilitychange', this.change);
  }
  get visible(): boolean { return !this.page.hidden && this.intersecting; }
  dispose(): void {
    this.observer?.disconnect();
    this.page.removeEventListener('visibilitychange', this.change);
  }
}
