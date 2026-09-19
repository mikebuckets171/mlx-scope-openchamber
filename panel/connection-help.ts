import type { HostClient, ServiceStatus } from '@openchamber/sdk';
import { unavailableForHostError } from './host-errors.ts';

export const serviceExplanation = (status: ServiceStatus): string => ({
  ready: 'The extension service is running. If readings are missing, check that oMLX is running and its saved connection is correct.',
  starting: 'OpenChamber is starting the extension service. Give it a moment, then refresh.',
  stopped: 'The extension service is stopped. Open Settings → Extensions, check its approval, then reopen MLX Scope.',
  failed: 'The extension service could not start. Check its approval in Settings → Extensions, then reload the extension.',
})[status];

/** Checks the documented host service status only when requested by the user. */
export class ConnectionHelp {
  private disposed = false;
  private busy = false;
  private readonly check: HTMLButtonElement;
  private readonly guide: HTMLButtonElement;
  private readonly status: HTMLElement;
  constructor(root: HTMLElement, private readonly host: Pick<HostClient, 'serviceStatus' | 'openUrl'>, version: string) {
    this.check = root.querySelector('#check-connection')!;
    this.guide = root.querySelector('#connection-guide')!;
    this.status = root.querySelector('#connection-result')!;
    this.check.addEventListener('click', this.onCheck);
    this.guide.addEventListener('click', this.onGuide);
    this.guideURL = `https://github.com/mikebuckets171/mlx-scope-openchamber/blob/v${version}/docs/CONFIGURATION.md`;
  }
  private readonly guideURL: string;
  private readonly onCheck = async (): Promise<void> => {
    if (this.busy || this.disposed) return;
    this.busy = true; this.check.disabled = true;
    this.check.setAttribute('aria-busy', 'true');
    this.status.textContent = 'Checking the connection to OpenChamber…';
    try {
      const result = await this.host.serviceStatus();
      if (!this.disposed) this.status.textContent = serviceExplanation(result.status);
    } catch (error) {
      if (!this.disposed) this.status.textContent = unavailableForHostError(error).message ?? 'Connection check unavailable. Reopen the extension.';
    } finally {
      this.busy = false;
      if (!this.disposed) { this.check.disabled = false; this.check.removeAttribute('aria-busy'); }
    }
  };
  private readonly onGuide = async (): Promise<void> => {
    try { await this.host.openUrl(this.guideURL); }
    catch { if (!this.disposed) this.status.textContent = 'Could not open the guide. Find Configuration in the MLX Scope repository.'; }
  };
  dispose(): void {
    this.disposed = true;
    this.check.removeEventListener('click', this.onCheck); this.guide.removeEventListener('click', this.onGuide);
  }
}
