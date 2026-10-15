import type { HostClient, HostReadyContext, HostSessions, HostShells, HostProject } from '../host/types.ts';
import { html, morph } from '../render/html.ts';

export interface NextPreferences { workspace: boolean; shells: boolean }
export const NEXT_DEFAULTS: NextPreferences = { workspace: false, shells: false };
/** Keep a valid UTF-8 tail within the same byte cap requested from the host. */
export const outputTail = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let start = Math.max(0, bytes.length - 8_192);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
};
/** Device preferences never turn into server-wide choices on a host without device storage. */
export class NextPreferencesStore {
  value = { ...NEXT_DEFAULTS };
  #revision = 0;
  #writes = Promise.resolve();
  constructor(readonly host: HostClient, readonly ready: HostReadyContext) {}
  async load(): Promise<void> {
    if (!this.ready.features?.deviceStorage) return;
    const revision = this.#revision;
    let value: unknown;
    try { value = await this.host.storage.get('view.next', { scope: 'device' }); }
    catch (error) { if (revision === this.#revision) throw error; return; }
    if (revision !== this.#revision || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const data = value as Record<string, unknown>;
    // Older releases stored a design choice here. The standard instrument ignores that retired field.
    this.value = { workspace: data.workspace === true, shells: data.shells === true };
  }
  set(patch: Partial<NextPreferences>): Promise<void> {
    this.#revision++;
    this.value = { workspace: patch.workspace ?? this.value.workspace, shells: patch.shells ?? this.value.shells };
    if (!this.ready.features?.deviceStorage) return Promise.reject(new Error('Device preferences unavailable'));
    const next = { ...this.value };
    return this.#writes = this.#writes.catch(() => {}).then(() => this.host.storage.set('view.next', next, { scope: 'device' }));
  }
}

/** Workspace metadata is transient context, never evidence that a runtime request belongs to a chat. */
export class WorkspaceAwareness {
  sessions: HostSessions | null = null;
  shells: HostShells | null = null;
  output: string | null = null;
  message = '';
  #generation = 0;
  #outputRevision = 0;
  #key = '';
  #stops: Array<() => void> = [];
  constructor(readonly host: HostClient, readonly changed: () => void) {}
  configure(directory: string | null, visible: boolean, workspace: boolean, shells: boolean): void {
    const key = JSON.stringify([directory, visible, workspace, shells]);
    if (key === this.#key) return;
    this.#key = key; this.dispose();
    if (!visible || !workspace && !shells) return;
    if (!directory) { this.message = 'Open a registered project to see activity.'; this.changed(); return; }
    const generation = this.#generation;
    const keep = async (pending: Promise<() => void>): Promise<void> => {
      const stop = await pending;
      if (generation !== this.#generation) stop(); else this.#stops.push(stop);
    };
    let projectId = '', lookup = 0;
    const attach = async (projects: HostProject[]): Promise<void> => {
      const scan = ++lookup;
      let project = projects.find(row => row.directory === directory);
      if (!project && this.host.listWorktrees) {
        for (const candidate of projects) {
          if (generation !== this.#generation || scan !== lookup) return;
          const value = await this.host.listWorktrees(candidate.id);
          if (value.worktrees.some(row => row.directory === directory)) { project = candidate; break; }
        }
      }
      if (generation !== this.#generation || scan !== lookup) return;
      if (!project) {
        if (projectId) { this.#key = ''; this.configure(directory, visible, workspace, shells); return; }
        this.message = 'No registered project matches this directory.'; this.changed(); return;
      }
      if (projectId === project.id) return;
      if (projectId) { this.#key = ''; this.configure(directory, visible, workspace, shells); return; }
      projectId = project.id; this.message = '';
      const subscriptions: Promise<void>[] = [];
      if (workspace && this.host.onSessions) subscriptions.push(keep(this.host.onSessions(project.id, value => {
        if (generation !== this.#generation) return;
        this.sessions = value; this.changed();
      })));
      if (shells && this.host.onRunningShells) subscriptions.push(keep(this.host.onRunningShells({ kind: 'project', projectId: project.id }, value => {
        if (generation !== this.#generation) return;
        this.shells = value; this.changed();
      })));
      await Promise.all(subscriptions.map(value => value.catch(() => this.#failure(generation))));
      this.changed();
    };
    this.message = 'Connecting to project activity…'; this.changed();
    if (!this.host.onProjects) { this.message = 'Workspace activity is unavailable on this host.'; this.changed(); return; }
    void keep(this.host.onProjects(value => {
      if (generation !== this.#generation) return;
      if (value.state !== 'ready') {
        this.message = value.state === 'error' ? 'Project activity is unavailable.' : 'Loading project activity…'; this.changed(); return;
      }
      void attach(value.projects).catch(() => this.#failure(generation));
    })).catch(() => this.#failure(generation));
  }
  #failure(generation: number): void {
    if (generation !== this.#generation) return;
    this.message = 'Activity unavailable. Check extension approval in Settings.'; this.changed();
  }
  async readOutput(id: string): Promise<void> {
    if (!this.host.readShellOutput || ![...(this.shells?.shells ?? []), ...(this.shells?.ended ?? [])].some(row => row.id === id)) return;
    const generation = this.#generation, revision = ++this.#outputRevision;
    this.output = 'Loading output…'; this.changed();
    try {
      const value = await this.host.readShellOutput(id, { tailBytes: 8_192 });
      if (generation === this.#generation && revision === this.#outputRevision) this.output = outputTail(value.output) || 'No output reported.';
    } catch { if (generation === this.#generation && revision === this.#outputRevision) this.output = 'Output is no longer available.'; }
    if (generation === this.#generation && revision === this.#outputRevision) this.changed();
  }
  clearOutput(): void { this.#outputRevision++; this.output = null; this.changed(); }
  dispose(): void {
    this.#generation++;
    for (const stop of this.#stops.splice(0)) stop();
    this.sessions = null; this.shells = null; this.output = null; this.message = '';
  }
}

export class NextControls {
  readonly awareness: WorkspaceAwareness;
  readonly prefs: NextPreferencesStore;
  #visible = false;
  #ready: HostReadyContext;
  #stop: () => void;
  #error = '';
  #loaded = false;
  #disposed = false;
  constructor(readonly host: HostClient, readonly root: HTMLElement, ready: HostReadyContext, readonly changed: () => void) {
    document.documentElement.dataset.designMode = 'next';
    this.#ready = ready;
    this.prefs = new NextPreferencesStore(host, ready);
    this.awareness = new WorkspaceAwareness(host, () => this.render());
    root.addEventListener('change', this.#change); root.addEventListener('click', this.#click);
    this.#stop = host.onReady(next => { this.#ready = next; this.sync(); });
    void this.prefs.load().catch(this.#loadFailed).then(() => { if (this.#disposed) return; this.#loaded = true; this.sync(); this.changed(); });
    this.render();
  }
  setVisible(visible: boolean): void {
    if (this.#disposed || visible === this.#visible) return;
    const resumed = visible && !this.#visible && this.#loaded;
    this.#visible = visible; this.sync();
    if (resumed) void this.prefs.load().catch(this.#loadFailed).then(() => { if (this.#disposed) return; this.sync(); this.changed(); });
  }
  #loadFailed = (): void => { this.#error = 'Could not load device preferences. Choices apply to this view.'; };
  sync(): void {
    if (this.#disposed) return;
    const prefs = this.prefs.value;
    document.documentElement.dataset.designMode = 'next';
    this.awareness.configure(this.#ready.directory ?? null, this.#visible && !!this.root.querySelector('#scope-awareness'), prefs.workspace, prefs.shells);
    this.render();
  }
  render(): void {
    if (this.#disposed) return;
    const target = this.root.querySelector<HTMLElement>('#scope-awareness');
    if (!target) return;
    const prefs = this.prefs.value, data = this.awareness;
    const expanded = target.querySelector<HTMLDetailsElement>('details')?.open;
    target.hidden = false;
    const rows = (data.sessions?.sessions ?? []).filter(row => ['running', 'retrying', 'waiting-permission', 'waiting-question'].includes(row.activity));
    const shells = [...(data.shells?.shells ?? []), ...(data.shells?.ended.slice(-3) ?? [])].slice(0, 8);
    morph(target, html`<details class="awareness-settings"${expanded ? html` open` : ''}><summary>Other work</summary><p class="coverage-note">Optional project activity. Separate from engine measurements; shown only while Scope is visible.</p><label><input type="checkbox" data-awareness="workspace"${prefs.workspace ? html` checked` : ''}> Chats and subagents</label><label><input type="checkbox" data-awareness="shells"${prefs.shells ? html` checked` : ''}> Agent commands</label></details>${this.#error ? html`<p role="status">${this.#error}</p>` : ''}${this.#visible && (prefs.workspace || prefs.shells) ? html`<section class="awareness-card" aria-label="Project activity">${data.message ? html`<p role="status">${data.message}</p>` : ''}${prefs.workspace && data.sessions ? html`<h3>Chats and subagents</h3>${rows.length ? html`<ul>${rows.slice(0, 8).map(row => html`<li><span>${row.title}${row.parentId ? ' · Subagent' : ''}</span><span>${row.activity.replaceAll('-', ' ')}</span></li>`)}</ul>` : html`<p>No chats observed running.</p>`}${data.sessions.state !== 'ready' ? html`<p>Activity snapshot is incomplete.</p>` : ''}` : ''}${prefs.shells && data.shells ? html`<h3>Agent commands</h3>${shells.length ? html`<ul>${shells.map(row => html`<li><code>${row.command}</code><span>${row.status ?? (row.background ? 'Background' : 'Running')}</span><button type="button" class="btn quiet" data-shell-output="${row.id}">View output</button></li>`)}</ul>` : html`<p>No commands observed running.</p>`}` : ''}${data.output !== null ? html`<div class="shell-output"><button type="button" class="btn quiet" data-close-output>Close output</button><pre aria-label="Command output">${data.output}</pre><p>Last 8 KiB · read on request · kept only in this view</p></div>` : ''}</section>` : ''}`);
  }
  #change = (event: Event): void => {
    const target = event.target;
    let patch: Partial<NextPreferences>;
    if (target instanceof HTMLInputElement && ['workspace', 'shells'].includes(target.dataset.awareness ?? '')) patch = { [target.dataset.awareness!]: target.checked };
    else return;
    this.#error = '';
    void this.prefs.set(patch).catch(() => { this.#error = 'Changed here; could not save device preferences.'; this.render(); });
    this.sync(); this.changed();
  };
  #click = (event: Event): void => {
    const target = (event.target as Element | null)?.closest<HTMLElement>('[data-shell-output],[data-close-output]');
    if (target?.dataset.shellOutput) void this.awareness.readOutput(target.dataset.shellOutput);
    else if (target?.hasAttribute('data-close-output')) this.awareness.clearOutput();
  };
  dispose(): void { this.#disposed = true; this.#visible = false; this.#stop(); this.awareness.dispose(); this.root.removeEventListener('change', this.#change); this.root.removeEventListener('click', this.#click); }
}
