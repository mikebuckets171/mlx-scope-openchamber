import type { HostClient } from '@openchamber/sdk';
import { SavedObservations, SAVED_LIMIT, measurementLabels, observationReport, observationTitle, type Observation } from './saved.ts';

export const savedMarkup = `<section id="view-saved" role="tabpanel" aria-labelledby="tab-saved" tabindex="0" hidden>
  <div class="section-heading"><h2>Saved observations</h2><span id="saved-count">0 / ${SAVED_LIMIT}</span></div>
  <p class="insight-note">Saved on this OpenChamber host. Keeps the 12 newest saves; the oldest is replaced when full. No model names or chat content.</p>
  <div class="insight-actions"><button id="saved-clear" type="button" disabled>Clear saved</button></div>
  <p id="saved-state" role="status" class="insight-note">Nothing saved yet. Save a Live snapshot or a Compare capture.</p>
  <ol id="saved-list" class="saved-list"></ol>
</section>`;

export class SavedView {
  readonly store: SavedObservations;
  private busy = false;
  private loaded = false;
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly root: HTMLElement, private readonly host: Pick<HostClient, 'storage' | 'writeClipboard'>,
    private readonly status: (text: string) => void) {
    this.store = new SavedObservations(host.storage);
    this.node('saved-clear').addEventListener('click', () => void this.act(async () => {
      await this.store.clear(); this.status('Saved observations cleared.');
    }));
  }
  private node(id: string): HTMLElement { return this.root.querySelector<HTMLElement>(`#${id}`)!; }
  private act(work: () => Promise<void>): Promise<void> {
    const next = this.pending.then(async () => {
      this.busy = true; this.render();
      try { await work(); }
      catch { this.status('Could not update saved observations. Nothing was confirmed saved or deleted.'); }
      finally { this.busy = false; this.render(); }
    });
    this.pending = next; return next;
  }
  load(): Promise<void> {
    return this.act(async () => {
      this.node('saved-state').textContent = 'Loading saved observations…';
      try { await this.store.load(); this.loaded = true; }
      catch { this.node('saved-state').textContent = 'Saved observations unavailable. Monitoring still works; open Saved again to retry.'; this.loaded = false; }
    });
  }
  async save(item: Observation): Promise<void> {
    await this.act(async () => {
      await this.store.load();
      await this.store.save(item); this.loaded = true; this.status('Observation saved without model names or chat content.');
    });
  }
  private render(): void {
    this.node('saved-count').textContent = `${this.store.items.length} / ${SAVED_LIMIT}`;
    (this.node('saved-clear') as HTMLButtonElement).disabled = this.busy || !this.loaded || !this.store.items.length;
    if (this.loaded) this.node('saved-state').textContent = this.store.items.length ? 'Observations are not completion records or controlled benchmarks.' : 'Nothing saved yet. Save a Live snapshot or a Compare capture.';
    const list = this.node('saved-list'); list.replaceChildren();
    for (const item of this.store.items) {
      const row = document.createElement('li'); row.className = 'saved-row';
      const heading = document.createElement('div'); heading.className = 'section-heading';
      const title = document.createElement('h3'); title.textContent = observationTitle(item);
      const time = document.createElement('time'); time.dateTime = new Date(item.savedAt).toISOString(); time.textContent = new Date(item.savedAt).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
      heading.append(title, time);
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      const state = item.state === 'interrupted' ? 'Partial capture' : item.state === 'finished' ? 'Finished window'
        : item.state === 'held' ? 'Held reading' : 'Observed snapshot';
      summary.append(`Measurements · ${state.toLowerCase()}`);
      const disclosure = document.createElement('span'); disclosure.textContent = '+'; disclosure.setAttribute('aria-hidden', 'true');
      summary.append(disclosure); details.append(summary);
      const context = document.createElement('div'); context.className = 'saved-context';
      const observed = document.createElement('p'); observed.append('Observed ');
      const observedTime = document.createElement('time'); observedTime.dateTime = new Date(item.sampledAt).toISOString();
      observedTime.textContent = new Date(item.sampledAt).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit'});
      observed.append(observedTime); context.append(observed);
      if (item.reference) {
        const reference = document.createElement('p');
        const referenceState = item.referenceState === 'interrupted' ? 'Partial reference' : item.referenceState === 'finished' ? 'Finished reference' : 'Reference status not recorded';
        reference.append(`${referenceState} · `);
        if (item.referenceSampledAt) {
          const referenceTime = document.createElement('time'); referenceTime.dateTime = new Date(item.referenceSampledAt).toISOString();
          referenceTime.textContent = new Date(item.referenceSampledAt).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit'});
          reference.append(referenceTime);
        } else reference.append('time not recorded');
        context.append(reference);
      }
      details.append(context);
      const table = document.createElement('table'); table.className = 'saved-measurements';
      table.dataset.comparison = String(Boolean(item.reference)); table.setAttribute('aria-label', 'Saved measurements');
      const head = table.createTHead().insertRow();
      for (const label of ['Reading', 'Observed', ...(item.reference ? ['Reference'] : [])]) {
        const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; head.append(cell);
      }
      const body = table.createTBody();
      for (const key of Object.keys(measurementLabels) as (keyof typeof measurementLabels)[]) {
        if (!Object.hasOwn(item.measurements, key) && !Object.hasOwn(item.reference ?? {}, key)) continue;
        const measurement = body.insertRow();
        const label = document.createElement('th'); label.scope = 'row'; label.textContent = measurementLabels[key][0];
        const unit = measurementLabels[key][1];
        if (unit) { const unitLabel = document.createElement('small'); unitLabel.textContent = unit; label.append(unitLabel); }
        measurement.append(label);
        for (const values of [item.measurements, ...(item.reference ? [item.reference] : [])]) {
          const cell = measurement.insertCell(); const value = values[key];
          cell.textContent = value == null ? '—' : key === 'prefillRemaining' && value > 0 && value < 1 ? '<1' : Number(value.toFixed(2)).toLocaleString();
          if (value == null) cell.setAttribute('aria-label', 'Not reported');
        }
      }
      details.append(table);
      if (item.reference) {
        const note = document.createElement('p'); note.className = 'saved-reference-note';
        note.textContent = 'Model identity is not stored. Differences do not establish causality.'; details.append(note);
      }
      const actions = document.createElement('div'); actions.className = 'insight-actions';
      const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy'; copy.disabled = this.busy;
      copy.addEventListener('click', async () => {
        copy.disabled = true;
        try { await this.host.writeClipboard(observationReport(item)); this.status('Saved observation copied.'); }
        catch { this.status('Could not copy the saved observation. The clipboard was not confirmed.'); }
        finally { copy.disabled = this.busy; }
      });
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete'; remove.disabled = this.busy;
      remove.setAttribute('aria-label', `Delete ${observationTitle(item).toLowerCase()} from ${time.textContent}`);
      remove.addEventListener('click', () => void this.act(async () => {
        await this.store.delete(item); this.status('Saved observation deleted.');
        this.node('tab-saved').focus({preventScroll:true});
      }));
      actions.append(copy, remove); row.append(heading, details, actions); list.append(row);
    }
  }
}
