/** Activation checks are bounded to the first minute of an open setup screen. */
export class SetupRefresh {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private visible = false;
  private pending = false;
  private until = 0;
  constructor(private readonly check: () => Promise<void>, private readonly now = () => Date.now()) {}
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible; this.until = visible ? this.now() + 60_000 : 0; this.schedule();
  }
  setPending(pending: boolean): void { this.pending = pending; this.schedule(); }
  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.visible || !this.pending || this.now() + 10_000 > this.until) return;
    this.timer = setTimeout(() => { this.timer = null; if (this.visible && this.pending) void this.check(); }, 10_000);
  }
  dispose(): void { this.visible = false; this.pending = false; this.schedule(); }
}
