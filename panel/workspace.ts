export type Workspace = 'live' | 'compare' | 'saved';

/** Local tabs use normal DOM focus semantics inside the extension's own frame. */
export class WorkspaceTabs {
  private readonly tabs: HTMLButtonElement[];
  constructor(private readonly root: HTMLElement, private readonly select: (view: Workspace) => void) {
    this.tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    this.tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => this.open(tab));
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? this.tabs.length - 1
          : (index + (event.key === 'ArrowLeft' ? -1 : 1) + this.tabs.length) % this.tabs.length;
        this.tabs[next]!.focus({preventScroll:true}); this.open(this.tabs[next]!);
      });
    });
  }
  private open(selected: HTMLButtonElement): void {
    if (selected.getAttribute('aria-selected') === 'true') return;
    this.tabs.forEach(tab => {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
      this.root.querySelector<HTMLElement>(`#${tab.getAttribute('aria-controls')}`)!.hidden = !active;
    });
    this.select(selected.dataset.view as Workspace);
  }
}
