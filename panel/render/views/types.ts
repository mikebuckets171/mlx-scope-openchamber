import type { HostClient } from '@openchamber/sdk';
import type { SnapshotV2, Surface } from '../../../src/contract/snapshot.ts';

// Owner: ui-core. How a tab or surface view plugs into the shell; heavy views load lazily. History (ui-history) uses it.

export type Tab = 'live' | 'server' | 'history' | 'captures';
export interface ViewContext {
  host: HostClient;
  surface: Surface;
  now: () => number;                         // service clock (SnapshotClient.now)
  visible: () => boolean;                    // data/visibility.ts
  leader: () => boolean;                     // lease.leader of the newest snapshot
}
export interface ViewHandle {
  update(snapshot: SnapshotV2 | null): void;
  dispose(): void;
}
export type MountView = (root: HTMLElement, context: ViewContext) => ViewHandle;
