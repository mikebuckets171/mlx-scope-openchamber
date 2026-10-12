import type { HostClient } from '../host/types.ts';
import { mediaJobKey } from './present.ts';
import { mediaTerminal, parseMediaSnapshot, type MediaJobV1, type MediaSnapshotV1 } from '../../src/contract/media.ts';
import { Poller, freshnessDeadline } from '../data/poller.ts';
import { unavailableForHostError, unavailableForServiceResponse } from '../host-errors.ts';

/** A frame has one demand-gated reader; the service coalesces reads from multiple frames. */
export class MediaController {
  snapshot: MediaSnapshotV1 | null = null;
  error: string | null = null;
  actionError: string | null = null;
  stale = false;
  readonly cancelling = new Set<string>();
  confirm: string | null = null;
  #visible = false;
  #wanted = false;
  #enabled = true;
  #disposed = false;
  #generation = 0;
  #staleTimer: ReturnType<typeof setTimeout> | null = null;
  #poller = new Poller(() => this.#read());
  #host: Pick<HostClient, 'serviceRequest'>;
  #changed: () => void;
  #now: () => number;
  constructor(host: Pick<HostClient, 'serviceRequest'>, changed: () => void, now = () => Date.now()) {
    this.#host = host; this.#changed = changed; this.#now = now;
  }
  sync(wanted: boolean): void {
    this.#wanted = wanted;
    const visible = wanted && this.#enabled;
    if (this.#disposed || this.#visible === visible) return;
    this.#visible = visible; this.#generation += 1;
    if (visible) { this.stale = true; this.#poller.start(); }
    else { this.#poller.stop(); this.#clearDeadline(); this.stale = true; this.confirm = null; }
  }
  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (!enabled && this.snapshot) this.snapshot = { ...this.snapshot, enabled: false, jobs: [], sources: [] };
    this.sync(this.#wanted);
  }
  refresh(): Promise<void> { if (this.#visible && !this.#disposed) this.#poller.start(); return this.#poller.refresh(); }
  #clearDeadline(): void { if (this.#staleTimer !== null) clearTimeout(this.#staleTimer); this.#staleTimer = null; }
  async #read(): Promise<number> {
    const generation = this.#generation;
    try {
      const response = await this.#host.serviceRequest({ method: 'GET', path: '/v2/media' });
      if (generation !== this.#generation || this.#disposed) return 5_000;
      if (response.status !== 200) { this.error = response.status === 404 ? 'Media monitoring needs the current Scope service. Reopen the extension when active work has finished.' : unavailableForServiceResponse(response.status).message; this.stale = true; this.#changed(); return 10_000; }
      const snapshot = parseMediaSnapshot(JSON.parse(response.body));
      if (!snapshot) throw new Error('Invalid media snapshot');
      this.snapshot = snapshot; this.error = null; this.stale = false;
      for (const key of this.cancelling) if (!snapshot.jobs.some(job => mediaJobKey(job) === key && !mediaTerminal(job.state))) this.cancelling.delete(key);
      if (this.confirm && !snapshot.jobs.some(job => mediaJobKey(job) === this.confirm && job.cancel.supported && job.freshness === 'live')) this.confirm = null;
      this.#clearDeadline();
      this.#staleTimer = setTimeout(() => { this.#staleTimer = null; this.stale = true; this.#changed(); }, freshnessDeadline(snapshot.nextPollMs));
      if (snapshot.enabled === false) this.setEnabled(false);
      this.#changed(); return snapshot.nextPollMs;
    } catch (error) {
      if (generation === this.#generation && !this.#disposed) { this.error = unavailableForHostError(error).message; this.stale = true; this.#changed(); }
      return 10_000;
    }
  }
  requestCancel(key: string): void {
    const job = this.snapshot?.jobs.find(job => mediaJobKey(job) === key);
    if (!job?.cancel.supported || job.freshness !== 'live' || this.stale || mediaTerminal(job.state)) return;
    this.actionError = null; this.confirm = key; this.#changed();
  }
  async cancel(key: string): Promise<void> {
    const job: MediaJobV1 | undefined = this.snapshot?.jobs.find(job => mediaJobKey(job) === key);
    if (this.confirm !== key || !job?.cancel.supported || this.stale || job.freshness !== 'live' || mediaTerminal(job.state) || this.cancelling.has(key)) return;
    this.confirm = null; this.cancelling.add(key); this.#changed();
    try {
      const response = await this.#host.serviceRequest({ method: 'POST', path: '/v2/media/cancel', body: JSON.stringify({ sourceId: job.sourceId, jobId: job.id }) });
      if (this.#disposed) return;
      const result = response.status === 200 ? JSON.parse(response.body) : null;
      if (result?.schemaVersion !== 1 || result.sourceId !== job.sourceId || result.jobId !== job.id || result.status !== 'requested') {
        this.cancelling.delete(key);
        this.actionError = result?.status === 'conflict' ? 'The backend’s active job changed. Refresh before trying again.' : result?.status === 'not-found' ? 'That job has already ended or is no longer available.' : 'This job could not be cancelled. Check its generating application.';
      }
    } catch { if (!this.#disposed) { this.cancelling.delete(key); this.actionError = 'Cancellation was not confirmed. Check the job before trying again.'; } }
    if (!this.#disposed) { this.#changed(); await this.refresh(); }
  }
  dismissCancel(): void { this.confirm = null; this.#changed(); }
  dispose(): void { this.#disposed = true; this.#poller.stop(); this.#clearDeadline(); this.cancelling.clear(); }
}
