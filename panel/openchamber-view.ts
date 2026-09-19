import type { HostClient, SessionSnapshot } from '@openchamber/sdk';
import { mountButton, type ButtonHandle } from '@openchamber/sdk/ui';

/** View-local disclosure built from supported SDK buttons. No host DOM access. */
export class SharingControls {
  private session: SessionSnapshot | null = null;
  private busy = false;
  private disposed = false;
  private open = false;
  private readonly trigger: HTMLButtonElement;
  private readonly triggerHandle: ButtonHandle;
  private readonly popup = document.createElement('div');
  private readonly items: { id: string; node: HTMLButtonElement; handle: ButtonHandle }[] = [];
  private readonly unsubscribe: () => void;

  constructor(private readonly root: HTMLElement,
    private readonly host: Pick<HostClient, 'onSession' | 'compose' | 'writeClipboard'>,
    private readonly report: () => string, private readonly status: (message: string) => void) {
    this.triggerHandle = mountButton(root, {
      label: 'Share', variant: 'ghost', size: 'xs', onClick: () => this.setOpen(!this.open),
    });
    this.trigger = root.querySelector('button')!;
    this.trigger.setAttribute('aria-label', 'Share');
    this.trigger.setAttribute('aria-haspopup', 'menu');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.popup.className = 'share-menu';
    this.popup.setAttribute('role', 'menu');
    this.popup.setAttribute('aria-label', 'Share readings');
    this.popup.tabIndex = -1;
    this.popup.hidden = true;
    root.append(this.popup);
    for (const [id, label] of [['copy-stats', 'Copy stats'], ['compose-stats', 'Add to chat draft']]) {
      const holder = document.createElement('div');
      this.popup.append(holder);
      const handle = mountButton(holder, {label, variant: 'ghost', size: 'sm', onClick: () => {
        this.setOpen(false, true);
        void this.share(id);
      }});
      const node = holder.querySelector('button')!;
      node.setAttribute('role', 'menuitem');
      node.tabIndex = -1;
      this.items.push({id, node, handle});
    }
    root.addEventListener('keydown', this.onKey);
    root.addEventListener('focusout', this.onFocusOut);
    document.addEventListener('pointerdown', this.onOutside, true);
    window.addEventListener('blur', this.onBlur);
    this.unsubscribe = host.onSession(session => { this.session = session; this.render(); });
    this.render();
  }

  private setOpen(value: boolean, restoreFocus = false): void {
    if (this.disposed) return;
    this.open = value;
    this.popup.hidden = !value;
    this.trigger.setAttribute('aria-expanded', String(value));
    // Prevent focusing a toolbar action from scrolling the containing host iframe.
    if (value) this.items.find(item => !item.node.disabled)?.node.focus({preventScroll: true});
    else if (restoreFocus) this.trigger.focus({preventScroll: true});
  }

  private readonly onOutside = (event: PointerEvent): void => {
    if (event.target instanceof Node && !this.root.contains(event.target)) this.setOpen(false);
  };
  private readonly onFocusOut = (event: FocusEvent): void => {
    if (event.relatedTarget instanceof Node && !this.root.contains(event.relatedTarget)) this.setOpen(false);
  };
  private readonly onBlur = (): void => { this.setOpen(false); };
  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.open) {
      event.preventDefault(); event.stopPropagation(); this.setOpen(false, true); return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const wasOpen = this.open;
    if (!wasOpen) this.setOpen(true);
    const enabled = this.items.filter(item => !item.node.disabled);
    if (!enabled.length) return;
    const at = enabled.findIndex(item => item.node === document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
      : !wasOpen ? (event.key === 'ArrowUp' ? enabled.length - 1 : 0)
      : (at + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length;
    enabled[index]?.node.focus({preventScroll: true});
  };

  private render(): void {
    if (this.disposed) return;
    this.items.forEach(item => item.handle.update({disabled: this.busy || (item.id === 'compose-stats' && !this.session)}));
  }

  private async share(id: string): Promise<void> {
    if (this.disposed || this.busy || !['copy-stats', 'compose-stats'].includes(id)) return;
    if (id === 'compose-stats' && !this.session) return;
    this.busy = true;
    this.render();
    try {
      const text = this.report().slice(0, 15_500);
      if (id === 'copy-stats') {
        await this.host.writeClipboard(text);
        if (!this.disposed) this.status('Stats copied. No credentials or chat content included.');
      } else {
        await this.host.compose({ text, mode: 'append' });
        if (!this.disposed) this.status('Added to the chat draft. Nothing was sent automatically.');
      }
    } catch {
      if (!this.disposed) this.status(id === 'copy-stats'
        ? 'Could not copy stats. The clipboard was not confirmed.'
        : 'Could not confirm the draft update. Check the chat before trying again.');
    } finally { this.busy = false; this.render(); }
  }

  dispose(): void {
    this.setOpen(false);
    this.disposed = true;
    this.unsubscribe();
    this.root.removeEventListener('keydown', this.onKey);
    this.root.removeEventListener('focusout', this.onFocusOut);
    document.removeEventListener('pointerdown', this.onOutside, true);
    window.removeEventListener('blur', this.onBlur);
    this.items.forEach(item => item.handle.dispose());
    this.triggerHandle.dispose();
    this.popup.remove();
  }
}
