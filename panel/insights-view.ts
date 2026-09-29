import type { CompletionV2 } from '../src/contract/completion.ts';
import { recentGenerationsReport, SessionInsights } from './insights.ts';
import { presentGeneration } from './present/captures.ts';
import { presentRecent } from './present/live.ts';
import type { Reading } from './present/reading.ts';
import { presentInsights } from './present/server.ts';
import { put, syncChildren } from './render/dom.ts';

/** Small observation-driven views: no new poller, frame loop, chart library, or persisted request data. */
export class InsightView {
  readonly history = new SessionInsights();
  private recentVersion = '';
  constructor(private readonly root: HTMLElement) {}
  private node(id: string): HTMLElement { return this.root.querySelector<HTMLElement>(`#${id}`)!; }
  private text(id: string, value: string): void { put(this.node(id), value); }

  update(reading: Reading, lastRequest: CompletionV2 | null): void {
    this.history.observe(reading);
    const recent = presentRecent(reading, this.history.speed), view = presentInsights(reading, lastRequest);
    this.node('prefill-estimate').hidden = recent.estimateHidden;
    this.text('prefill-eta', recent.estimate);
    this.text('window-speed', recent.windowSpeed);
    this.text('window-span', recent.windowSpan);
    const cache = view.cache, lens = this.node('cache-lens');
    lens.hidden = cache.hidden;
    this.text('cache-reuse-count', cache.reused);
    this.text('cache-new-count', cache.fresh);
    this.node('cache-reused-fill').style.width = `${cache.fill}%`;
    this.node('cache-input-bar').dataset.available = String(cache.available);
    this.node('cache-input-bar').setAttribute('aria-label', cache.barLabel);
    this.text('cache-ram-size', cache.ram);
    this.text('cache-ssd-size', cache.ssd);
    this.text('cache-bank-state', cache.bankState);
    lens.dataset.stale = String(cache.stale);
    this.text('cache-request-state', cache.requestState);
    this.text('cache-scope', cache.scope);
    lens.querySelectorAll<HTMLElement>('.cache-tier-values, #cache-bank-state').forEach(element => { element.hidden = cache.tiersHidden; });
    this.text('runtime-advisory', view.advisory); this.node('runtime-advisory').hidden = !view.advisory;

    const residents = view.residents;
    this.node('resident-section').hidden = residents.hidden;
    this.text('resident-count', residents.count);
    this.text('resident-note', residents.note);
    syncChildren(this.node('resident-list'), residents.rows, () => {
      const row = document.createElement('li'); row.className = 'resident-row';
      // Static markup only; runtime strings are always assigned with textContent.
      row.innerHTML = '<div class="resident-heading"><strong></strong><span></span></div><div class="resident-reading"><span></span><span></span></div>';
      return row;
    }, (row, model) => {
      row.dataset.phase = model.phase;
      put(row.querySelector('strong')!, model.name);
      row.querySelector('strong')!.setAttribute('title', model.title);
      put(row.querySelector('.resident-heading span')!, model.label);
      put(row.querySelector('.resident-reading span')!, model.reading);
      put(row.querySelector('.resident-reading span:last-child')!, model.allocation);
    });
    const catalog = view.catalog;
    this.node('catalog-section').hidden = catalog.hidden;
    this.text('catalog-title', catalog.title);
    this.text('catalog-count', catalog.count);
    this.text('catalog-note', catalog.note);
    syncChildren(this.node('catalog-list'), catalog.rows, () => {
      const row = document.createElement('li'); row.className = 'catalog-row';
      row.innerHTML = '<strong></strong><span class="catalog-state"></span><span class="catalog-format"></span><span class="catalog-context"></span>';
      return row;
    }, (row, model) => {
      put(row.querySelector('strong')!, model.name);
      row.dataset.loaded = String(model.loaded);
      put(row.querySelector('.catalog-state')!, model.state);
      const badge = row.querySelector<HTMLElement>('.catalog-format')!;
      badge.dataset.format = model.format;
      put(badge, model.formatLabel);
      put(row.querySelector('.catalog-context')!, model.context);
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
      const view = presentGeneration(record);
      const row = document.createElement('li'); row.className = 'generation-row';
      const heading = document.createElement('div'); heading.className = 'generation-heading';
      const title = document.createElement('strong'); title.textContent = view.name;
      title.title = view.title;
      const time = document.createElement('time'); time.dateTime = view.at;
      time.textContent = view.time;
      heading.append(title, time);
      const measurements = document.createElement('div'); measurements.className = 'generation-values';
      const speed = document.createElement('strong'); speed.textContent = view.speed;
      const counts = document.createElement('span'); counts.textContent = view.tokens;
      measurements.append(speed, counts);
      const note = document.createElement('p'); note.className = 'insight-note';
      note.textContent = view.note;
      row.append(heading, measurements, note); list.append(row);
    }
  }
}
