import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import type { AttributionLabel } from '../attribution/join.ts';
import type { NextReplyState } from '../attribution/next-reply.ts';
import type { RegressionFlag, VsUsual } from '../history/regress.ts';
import type { SignalPoint } from '../signal.ts';
import type { PanelReason } from './reading.ts';

/** Why the newest poll has no body: a frame-side state (host error, version skew, approval pending). */
export interface FrameIssue { reason: PanelReason; message: string | null }
/** The newest finished request, with the label its verdict carries and how it compares with the usual. */
export interface LastReply { completion: CompletionV2; label: AttributionLabel; vsUsual: VsUsual | null; flag: RegressionFlag | null }

/** Everything one render of any 2.0 surface needs. Presenters are pure functions of it (P10). */
export interface ScopeInput {
  now: number;                               // the frame's time on the service clock
  version: string;
  snapshot: SnapshotV2 | null;               // the newest body, retained through a missed poll
  fresh: boolean;                            // the body is the newest poll's and inside the no-fresh-reading deadline
  stale?: boolean;                           // the no-fresh-reading deadline passed (otherwise a not-fresh body is refreshing)
  frame: FrameIssue | null;                  // the newest poll had no body
  paused: boolean;
  attribution: AttributionLabel;             // the live reading's label (attribution join)
  chatRuntime: string | null;                // the open chat's runtime name, for "this chat uses …"
  last: LastReply | null;
  next: NextReplyState;
  samples: readonly SignalPoint[];           // the panel's own 90 s ring
  turnStartAt: number | null;                // this chat's turn start, when observed live
}
export const SERVER_WIDE: AttributionLabel = { kind: 'server-wide', reason: 'not-observed' };

/** The model a reading is about: the request's, else the loaded one. */
export const modelOf = (snapshot: SnapshotV2 | null): string | null => snapshot
  ? snapshot.runtime.request?.model ?? snapshot.runtime.residency[0]?.model ?? snapshot.runtime.catalog.find(model => model.loaded)?.name ?? null
  : null;
/** A model name for 280 px: no publisher, no quantisation suffix. */
export const glanceModel = (model: string): string => (model.split('/').at(-1) ?? model).replace(/[-_.](?:\d+bit|mlx|q\d\w*|gguf|splash)$/i, '');
/** Splash's readings are last observed while it recovers or its status is stale. */
export const heldBySource = (snapshot: SnapshotV2): boolean => snapshot.status.state === 'recovering' || snapshot.status.reason === 'status_stale';
