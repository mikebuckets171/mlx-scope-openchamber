import type { HostClient } from '@openchamber/sdk';
import type { SnapshotV2, Surface } from '../../../src/contract/snapshot.ts';

// Owner: ui-core. How a tab or surface view plugs into the shell; heavy views load lazily. History (ui-history) uses it.

export type Tab = 'live' | 'server' | 'history' | 'captures' | 'media';
export type PrimaryTab = 'live' | 'media' | 'history';
/** Secondary workspaces stay inside their parent destination, including during resize. */
export const primaryTab = (view: Tab): PrimaryTab => view === 'media' ? 'media' : view === 'history' || view === 'captures' ? 'history' : 'live';
export interface ViewContext {
  host: HostClient;
  surface: Surface;
  now: () => number;                         // service clock (SnapshotClient.now)
  visible: () => boolean;                    // data/visibility.ts
  leader: () => boolean;                     // lease.leader of the newest snapshot
}
export interface ViewHandle {
  update(snapshot: SnapshotV2 | null): void;
  /** Refresh view-owned storage when entered, without replacing in-progress work. */
  activate?(): void;
  /** A view-owned timed capture stays reachable while its workspace is hidden. */
  captureActivity?(): string | null;
  cancelCapture?(): void;
  dispose(): void;
}
export type MountView = (root: HTMLElement, context: ViewContext) => ViewHandle;
