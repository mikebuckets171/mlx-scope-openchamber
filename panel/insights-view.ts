import type { TelemetrySnapshot } from '../src/telemetry.ts';
import { cacheSplit, prefillEstimate, recentGenerationsReport, SessionInsights } from './insights.ts';

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const rate = (value: number | null) => value === null ? '—' : `${number.format(value)} tok/s`;
const size = (gb: number | null | undefined) => gb == null ? '—' : `${number.format(gb * 1e9 / 1024 ** 3)} GiB`;
const phases: Record<string, string> = { decode: 'Generating', prefill: 'Reading context', idle: 'Ready', queued: 'Queued', processing: 'Processing', unknown: 'Unavailable' };
const put = (element: Element, text: string) => { if (element.textContent !== text) element.textContent = text; };

/** Small observation-driven views: no new poller, frame loop, chart library, or persisted request data. */
export class InsightView {
  readonly history = new SessionInsights();
  private recentVersion = '';
  constructor(private readonly root: HTMLElement) {}
  private node(id: string): HTMLElement { return this.root.querySelector<HTMLElement>(`#${id}`)!; }
  private text(id: string, value: string): void { put(this.node(id), value); }

  update(snapshot: TelemetrySnapshot): void {
    this.history.observe(snapshot);
    const current = snapshot.available ? snapshot : null;
    const estimate = prefillEstimate(current);
    this.node('prefill-estimate').hidden = estimate === null;
    this.text('prefill-eta', estimate ?? '—');
    const speed = current?.phase === 'decode' ? this.history.speed : null;
    this.node('recent-speed').hidden = current?.phase !== 'decode';
    this.text('window-speed', speed ? rate(speed.tokensPerSecond) : 'Gathering samples…');
    this.text('window-span', speed ? `Observed over ${number.format(speed.seconds)}s` : 'Recent speed · needs 2s of observations');
    const split = cacheSplit(current);
    this.text('cache-reuse-count', split ? integer.format(split.reused) : '—');
    this.text('cache-new-count', split ? integer.format(split.fresh) : '—');
    this.node('cache-reused-fill').style.width = `${split?.percent ?? 0}%`;
    this.node('cache-input-bar').dataset.available = String(split !== null);
    this.node('cache-input-bar').setAttribute('aria-label', split ? `${integer.format(split.reused)} input tokens reused; ${integer.format(split.fresh)} not reused` : 'Cache reuse unavailable for the current request');
    const statsFresh = current?.sessionStatsState === 'fresh';
    this.text('cache-ram-size', size(current?.sessionBank?.hot?.totalGB));
    this.text('cache-ssd-size', size(current?.sessionBank?.cold?.totalGB));
    this.text('cache-bank-state', statsFresh ? 'Server cache · categories can overlap' : 'Cache totals not live');
    this.node('cache-lens').dataset.stale = String(!current);
    this.text('cache-request-state', split ? `${number.format(split.percent)}% of input reused` : 'Current request · reuse not reported');
    const warning = current?.memoryPressureLevel && current.memoryPressureLevel >= 2
      ? 'oMLX memory guard elevated. This is the runtime’s guard, not macOS memory pressure.'
      : current?.prefillProgressStale ? 'Prefill progress has not advanced. The stage estimate is withheld until fresh progress arrives.' : '';
    this.text('runtime-advisory', warning); this.node('runtime-advisory').hidden = !warning;

    const models = current?.residentModels ?? [];
    this.node('resident-section').hidden = models.length === 0;
    this.text('resident-count', current?.residentModelCount == null ? '' : `${current.residentModelCount} loaded`);
    this.text('resident-note', (current?.residentModelCount ?? 0) > models.length
      ? `Showing ${models.length} of ${current!.residentModelCount} reported models. Read-only; no model switching.`
      : 'Reported models · not assigned to a selected chat');
    const roster = this.node('resident-list');
    while (roster.children.length > models.length) roster.lastElementChild!.remove();
    models.forEach((model, index) => {
      let row = roster.children[index] as HTMLElement | undefined;
      if (!row) {
        row = document.createElement('li'); row.className = 'resident-row';
        // Static markup only; runtime strings are always assigned with textContent.
        row.innerHTML = '<div class="resident-heading"><strong></strong><span></span></div><div class="resident-reading"><span></span><span></span></div>';
        roster.append(row);
      }
      row.dataset.phase = model.phase;
      put(row.querySelector('strong')!, model.id.split('/').at(-1) ?? model.id);
      row.querySelector('strong')!.setAttribute('title', model.id);
      put(row.querySelector('.resident-heading span')!, phases[model.phase] ?? 'Unavailable');
      const progress = model.phase === 'prefill' && model.prefillProgress !== null
        ? `${model.prefillProgress < 1 && model.prefillProgress > .99 ? '<1' : Math.max(0, 100 - Math.floor(model.prefillProgress * 100 + Number.EPSILON * 100))}% left${model.progressStale ? ' · last reading' : ''}` : null;
      put(row.querySelector('.resident-reading span')!, progress ?? (model.tokensPerSecond !== null ? rate(model.tokensPerSecond)
        : `${model.activeRequests ?? '—'} active · ${model.queuedRequests ?? '—'} queued`));
      put(row.querySelector('.resident-reading span:last-child')!, `${size(model.allocationGB)} allocated`);
    });
    this.renderRecent();
  }

  suspend(): void {
    this.history.break();
    this.node('prefill-estimate').hidden = true;
    this.node('recent-speed').hidden = true;
    this.text('cache-request-state', 'Last reading · monitoring interrupted');
    this.text('cache-bank-state', 'Last reading · not live');
    this.text('resident-count', 'Last reading');
    this.renderRecent();
  }
  clear(): void { this.history.clear(); this.renderRecent(); }
  report(version: string): string { return recentGenerationsReport(this.history.recent, version); }

  private renderRecent(): void {
    const records = this.history.recent;
    const fingerprint = records.map(record => `${record.sequence}:${record.coverage}`).join('|');
    this.text('recent-count', `${records.length} / 8`);
    (this.node('copy-recent') as HTMLButtonElement).disabled = !records.length;
    (this.node('clear-recent') as HTMLButtonElement).disabled = !records.length;
    if (fingerprint === this.recentVersion) return;
    this.recentVersion = fingerprint;
    const list = this.node('recent-list'); list.replaceChildren();
    if (!records.length) {
      const empty = document.createElement('li'); empty.className = 'insight-note';
      empty.textContent = 'Generations appear here after they leave the active view.'; list.append(empty); return;
    }
    for (const record of records) {
      const row = document.createElement('li'); row.className = 'generation-row';
      const heading = document.createElement('div'); heading.className = 'generation-heading';
      const title = document.createElement('strong'); title.textContent = record.model.split('/').at(-1) ?? record.model;
      title.title = record.model;
      const time = document.createElement('time'); time.dateTime = new Date(record.lastSeenAt).toISOString();
      time.textContent = new Date(record.lastSeenAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      heading.append(title, time);
      const measurements = document.createElement('div'); measurements.className = 'generation-values';
      const speed = document.createElement('strong'); speed.textContent = rate(record.averageTPS);
      const counts = document.createElement('span'); counts.textContent = `${record.outputTokens === null ? '—' : integer.format(record.outputTokens)} tokens last seen`;
      measurements.append(speed, counts);
      const note = document.createElement('p'); note.className = 'insight-note';
      note.textContent = `${record.coverage === 'monitoring-gap' ? 'Monitoring gap' : 'No longer observed'}${record.peakProcessGB !== null ? ` · ${size(record.peakProcessGB)} peak observed footprint` : ''}`;
      row.append(heading, measurements, note); list.append(row);
    }
  }
}
