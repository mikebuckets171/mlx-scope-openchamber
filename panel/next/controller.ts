import type { HostClient, HostReadyContext, HostSessions, HostProject } from '../host/types.ts';
import { html, morph } from '../render/html.ts';

export interface NextPreferences { workspace: boolean }
export const NEXT_DEFAULTS: NextPreferences = { workspace: false };
/** Device preferences never turn into server-wide choices on a host without device storage. */
export class NextPreferencesStore {
  value = { ...NEXT_DEFAULTS };
  /** Fields this release does not use (5.0's `shells` choice) are written back unchanged. */
  #stored: Record<string, unknown> = {};
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
    // Older releases stored a design choice and an agent-command choice here; this release reads only `workspace`.
    this.#stored = { ...data };
    this.value = { workspace: data.workspace === true };
  }
  set(patch: Partial<NextPreferences>): Promise<void> {
    this.#revision++;
    this.value = { workspace: patch.workspace ?? this.value.workspace };
    if (!this.ready.features?.deviceStorage) return Promise.reject(new Error('Device preferences unavailable'));
    const next = { ...this.#stored, ...this.value };
    return this.#writes = this.#writes.catch(() => {}).then(() => this.host.storage.set('view.next', next, { scope: 'device' }));
  }
}

/** Workspace metadata is transient context, never evidence that a runtime request belongs to a chat. */
export class WorkspaceAwareness {
  sessions: HostSessions | null = null;
  message = '';
  #generation = 0;
  #key = '';
  #stops: Array<() => void> = [];
  constructor(readonly host: HostClient, readonly changed: () => void) {}
  configure(directory: string | null, visible: boolean, workspace: boolean): void {
    const key = JSON.stringify([directory, visible, workspace]);
    if (key === this.#key) return;
    this.#key = key; this.dispose();
    if (!visible || !workspace) return;
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
        if (projectId) { this.#key = ''; this.configure(directory, visible, workspace); return; }
        this.message = 'No registered project matches this directory.'; this.changed(); return;
      }
      if (projectId === project.id) return;
      if (projectId) { this.#key = ''; this.configure(directory, visible, workspace); return; }
      projectId = project.id; this.message = '';
      if (this.host.onSessions) await keep(this.host.onSessions(project.id, value => {
        if (generation !== this.#generation) return;
        this.sessions = value; this.changed();
      })).catch(() => this.#failure(generation));
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
  dispose(): void {
    this.#generation++;
    for (const stop of this.#stops.splice(0)) stop();
    this.sessions = null; this.message = '';
  }
}

/** What "running" means here: host-reported activity that would have appeared in the old per-chat rows. */
const ACTIVE = ['running', 'retrying', 'waiting-permission', 'waiting-question'];
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
/**
 * Other work is awareness, never evidence: one quiet line of counts, with no chat titles, no activity per chat and no
 * rows. Anything the host could not answer states itself instead of counting nothing as quiet.
 */
export const otherWorkLine = (data: WorkspaceAwareness): string => {
  if (data.message) return data.message;
  const rows = (data.sessions?.sessions ?? []).filter(row => ACTIVE.includes(row.activity));
  if (!rows.length) return 'No other chats running';
  const subagents = rows.filter(row => !!row.parentId).length;
  return `Other work · ${count(rows.length - subagents, 'chat', 'chats')}, ${count(subagents, 'subagent', 'subagents')} active`;
};

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
    root.addEventListener('click', this.#toggle);
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
    this.awareness.configure(this.#ready.directory ?? null, this.#visible && !!this.root.querySelector('#scope-awareness'), prefs.workspace);
    this.render();
  }
  render(): void {
    if (this.#disposed) return;
    const toggle = this.root.querySelector('#other-work');
    if (toggle && toggle.getAttribute('aria-pressed') !== String(this.prefs.value.workspace)) toggle.setAttribute('aria-pressed', String(this.prefs.value.workspace));
    const target = this.root.querySelector<HTMLElement>('#scope-awareness');
    if (!target) return;
    const wanted = this.#visible && this.prefs.value.workspace;
    target.hidden = !wanted && !this.#error;
    const line = wanted && this.awareness.sessions?.state !== 'ready' && !this.awareness.message ? 'Activity snapshot is incomplete.' : wanted ? otherWorkLine(this.awareness) : '';
    morph(target, html`${line ? html`<p class="awareness-line">${line}</p>` : ''}${this.#error ? html`<p role="status" class="awareness-line">${this.#error}</p>` : ''}`);
  }
  /** The menu toggle beside Compact: one device preference, the same patch path as before. */
  #toggle = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('#other-work')) return;
    this.#error = '';
    void this.prefs.set({ workspace: !this.prefs.value.workspace }).catch(() => { this.#error = 'Changed here; could not save device preferences.'; this.render(); });
    this.sync(); this.changed();
  };
  dispose(): void { this.#disposed = true; this.#visible = false; this.#stop(); this.awareness.dispose(); this.root.removeEventListener('click', this.#toggle); }
}
