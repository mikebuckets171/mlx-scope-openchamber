import type { HostClient } from '@openchamber/sdk';
import { RUNTIMES, runtimeNames, runtimeValue, type ConnectionInfo, type RuntimeSelection } from '../src/runtime.ts';

const STORAGE_KEY = 'connection.selection';
export const connectionsMarkup = `<section id="connection-setup" class="connection-setup" aria-labelledby="connection-setup-title" hidden>
  <div class="section-heading"><h2 id="connection-setup-title">Monitor a local runtime</h2><button id="connection-close" type="button" aria-label="Close connection setup">Close</button></div>
  <p class="insight-note">Uses existing local OpenCode connections. This only changes what MLX Scope observes.</p>
  <div id="connection-fields">
    <label for="connection-provider">Connection</label><select id="connection-provider"><option value="">Automatic</option></select>
    <label for="connection-runtime">Runtime</label><select id="connection-runtime"><option value="">Automatic detection</option>${RUNTIMES.map(runtime => `<option value="${runtime}">${runtimeNames[runtime]}</option>`).join('')}</select>
    <p id="connection-choice-note" class="insight-note">Choose a configured connection, or keep automatic detection.</p>
    <div class="insight-actions"><button id="connection-apply" type="button">Use connection</button></div>
  </div>
  <p class="insight-note">Credentials stay in the local service. Configure endpoints and keys in OpenCode; MLX Scope does not edit them.</p>
</section>`;

const selectionValue = (value: unknown): RuntimeSelection | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.provider !== 'string' || item.provider.length > 120 || /[\u0000-\u001f\u007f]/.test(item.provider)
    || item.runtime !== null && runtimeValue(item.runtime) === null) return null;
  return {provider:item.provider, runtime:runtimeValue(item.runtime)};
};

/** One saved selection; metadata arrives through the existing snapshot request. */
export class ConnectionsView {
  selection: RuntimeSelection = {provider:'', runtime:null};
  private choices: ConnectionInfo['choices'] = [];
  private revision = 0;
  private pending: Promise<void> = Promise.resolve();
  private readonly provider: HTMLSelectElement;
  private readonly runtime: HTMLSelectElement;
  private readonly setup: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  constructor(private readonly root: HTMLElement, private readonly storage: HostClient['storage'],
    private readonly change: () => void, private readonly status: (message: string) => void) {
    this.provider = this.node('connection-provider') as HTMLSelectElement;
    this.runtime = this.node('connection-runtime') as HTMLSelectElement;
    this.setup = this.node('connection-setup');
    this.trigger = this.node('connection-change') as HTMLButtonElement;
    this.trigger.addEventListener('click', () => this.setOpen(this.setup.hidden));
    this.node('connection-close').addEventListener('click', () => this.setOpen(false, true));
    this.node('connection-configure').addEventListener('click', () => this.setOpen(true, true));
    this.setup.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); this.setOpen(false, true); }
    });
    this.node('connection-apply').addEventListener('click', () => {
      const next = {provider:this.provider.value, runtime:runtimeValue(this.runtime.value)};
      this.revision += 1;
      this.commit(next);
      this.setOpen(false, true);
      const save = this.pending.catch(() => {}).then(() => this.storage.set(STORAGE_KEY, next));
      this.pending = save;
      void save.catch(() => this.status('Connection changed here, but OpenChamber could not save the preference.'));
    });
  }
  private node(id: string): HTMLElement { return this.root.querySelector<HTMLElement>(`#${id}`)!; }
  private commit(next: RuntimeSelection): void {
    if (this.selection.provider === next.provider && this.selection.runtime === next.runtime) return;
    this.selection = next;
    this.change();
  }
  async load(): Promise<void> {
    const revision = this.revision;
    try {
      const selection = selectionValue(await this.storage.get(STORAGE_KEY));
      if (selection && revision === this.revision) this.commit(selection);
    } catch { /* An unavailable preference store must not block monitoring. */ }
  }
  query(): Record<string, string> | undefined {
    const query: Record<string, string> = {};
    if (this.selection.provider) query.provider = this.selection.provider;
    if (this.selection.runtime) query.runtime = this.selection.runtime;
    return Object.keys(query).length ? query : undefined;
  }
  update(info: ConnectionInfo | null | undefined): void {
    if (!info) return;
    if (JSON.stringify(info.choices) !== JSON.stringify(this.choices)) {
      this.choices = info.choices;
      this.paintChoices();
    }
    this.node('connection-choice-note').textContent = info.choices.length
      ? 'Automatic detection uses the configured runtime when it can be identified. Select a runtime if detection is unavailable.'
      : 'No local connection was found. Add a local provider in OpenCode, then refresh MLX Scope. The setup guide lists supported configuration.';
  }
  private paintChoices(): void {
    const selected = this.setup.hidden ? this.selection.provider : this.provider.value;
    const entries = [{id:'',label:'Automatic',runtime:null}, ...this.choices];
    if (selected && !entries.some(choice => choice.id === selected)) entries.push({id:selected,label:`${selected} · not currently found`,runtime:null});
    this.provider.replaceChildren(...entries.map(choice => {
      const option = document.createElement('option'); option.value = choice.id;
      option.textContent = `${choice.label}${choice.runtime ? ` · ${runtimeNames[choice.runtime]}` : ''}`;
      return option;
    }));
    this.provider.value = selected;
  }
  private setOpen(open: boolean, focus = false): void {
    if (open) {
      this.paintChoices(); this.provider.value = this.selection.provider;
      this.runtime.value = this.selection.runtime ?? '';
    }
    this.setup.hidden = !open; this.trigger.setAttribute('aria-expanded', String(open));
    if (focus) (open ? this.provider : this.trigger).focus({preventScroll:true});
  }
}
