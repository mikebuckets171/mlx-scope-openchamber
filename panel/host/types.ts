/** The host services Scope uses. SDK types and upstream payloads stop at the adapter. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface SessionSnapshot { id: string; busy: boolean | null; model?: string }
export interface SessionLifecycleEvent { sessionId: string; phase: 'started' | 'completed' | 'failure' }
export interface HostFeatures { statusControls?: true; popovers?: true; deviceStorage?: true }
export interface HostProject { id: string; name: string; directory: string }
export interface HostSessions { state: 'loading' | 'ready' | 'error'; sessions: Array<{ id: string; title: string; parentId: string | null; activity: string; outcome: 'completed' | 'failed' | null; archivedAt: number | null }> }
export interface HostShell { id: string; command: string; startedAt: number; background: boolean; status?: string; exit?: number }
export interface HostShells { shells: HostShell[]; ended: HostShell[] }
export type StatusControl = { kind: 'button'; id: string; label: string; disabled?: boolean } | { kind: 'select'; id: string; label: string; value: string; options: Array<{ value: string; label: string }>; disabled?: boolean };
export interface PopoverRequest { id: string; anchor: { x: number; y: number; width: number; height: number }; width: number; height: number; side?: 'left' | 'right' | 'top' | 'bottom'; focus?: boolean; data: JsonValue }
export interface HostReadyContext {
  surface: 'panel' | 'page' | 'status' | 'dialog' | 'background' | 'file' | 'popover';
  theme: { mode: 'light' | 'dark'; tokens: Record<string, string> };
  session: SessionSnapshot | null;
  directory?: string | null;
  features?: HostFeatures;
  popover?: { id: string; data: JsonValue };
}
export type ServiceStatus = 'stopped' | 'starting' | 'ready' | 'failed';
export interface ToastRequest { kind: 'info' | 'success' | 'error'; message: string; copy?: boolean | { text: string }; dismiss?: boolean; persistent?: boolean }
export interface AttachIssueRequest { providerId: string; id: string; title: string; url: string; text?: string }
export interface HostClient {
  storage: {
    get(key: string, options?: { scope: 'device' }): Promise<JsonValue | undefined>;
    set(key: string, value: JsonValue, options?: { scope: 'device' }): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };
  onReady(listener: (ready: HostReadyContext) => void): () => void;
  onSession(listener: (session: SessionSnapshot | null) => void): () => void;
  onSessionLifecycle(listener: (event: SessionLifecycleEvent) => void): () => void;
  onProjects?(listener: (snapshot: { state: string; projects: HostProject[] }) => void): Promise<() => void>;
  listWorktrees?(projectId: string): Promise<{ worktrees: Array<{ directory: string }> }>;
  onSessions?(projectId: string, listener: (snapshot: HostSessions) => void): Promise<() => void>;
  onRunningShells?(scope: { kind: 'project'; projectId: string }, listener: (snapshot: HostShells) => void): Promise<() => void>;
  readShellOutput?(id: string, options: { tailBytes: number }): Promise<{ output: string; cursor: number; skipped: boolean }>;
  onStatusControl?(listener: (event: { id: string; value?: string }) => void): () => void;
  setStatusControls?(controls: StatusControl[]): Promise<void>;
  openPopover?(request: PopoverRequest): Promise<void>;
  close?(): Promise<void>;
  serviceRequest(request: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; query?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }>;
  serviceStatus(): Promise<{ status: ServiceStatus }>;
  openSurface(surface: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  compose(request: { text: string; mode?: 'replace' | 'append' }): Promise<void>;
  writeClipboard(text: string): Promise<void>;
  setBadge(count: number | null): Promise<void>;
  setHeight(height: number): Promise<void>;
  toast(request: ToastRequest): Promise<void>;
  dispose(): void;
}
