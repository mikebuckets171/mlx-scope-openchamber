/** The host services Scope uses. SDK types and upstream payloads stop at the adapter. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface SessionSnapshot { id: string; busy: boolean | null; model?: string }
export interface SessionLifecycleEvent { sessionId: string; phase: 'started' | 'completed' | 'failure' }
export interface HostReadyContext {
  surface: 'panel' | 'page' | 'status' | 'dialog' | 'background' | 'file';
  theme: { mode: 'light' | 'dark'; tokens: Record<string, string> };
  session: SessionSnapshot | null;
}
export type ServiceStatus = 'stopped' | 'starting' | 'ready' | 'failed';
export interface ToastRequest { kind: 'info' | 'success' | 'error'; message: string; copy?: boolean | { text: string }; dismiss?: boolean; persistent?: boolean }
export interface AttachIssueRequest { providerId: string; id: string; title: string; url: string; text?: string }
export interface HostClient {
  storage: {
    get(key: string): Promise<JsonValue | undefined>;
    set(key: string, value: JsonValue): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };
  onReady(listener: (ready: HostReadyContext) => void): () => void;
  onSession(listener: (session: SessionSnapshot | null) => void): () => void;
  onSessionLifecycle(listener: (event: SessionLifecycleEvent) => void): () => void;
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
