import type { CompletionDraft } from '../core/adapter-v2.ts';

// Owner: ad-lmstudio. Rewrite of service/lmstudio-activity.ts bound to one connection: resets on stream restart or
// connection change; healthy only after the first parsed JSON record; BoundedLines 16 KiB and the 60 s idle-stop stay.

export type ServerLineEvent =
  | { kind: 'started' } | { kind: 'progress'; fraction: number } | { kind: 'done'; completion: CompletionDraft } | { kind: 'finished' };
/** One `lms log stream -s server --json` record. A `Done ·` summary counts only as the record's own line, never inside generated text. */
export const parseServerRecord = (line: string, at: number): ServerLineEvent | null => {
  void line; void at;
  return null;
};
export interface ActivityView { active: number; queued: number; healthy: boolean; completions: CompletionDraft[] }
export interface ConnectionActivity {
  /** Starts or keeps the stream for this port; called only after a greeting within 10 s. */
  touch(port: number): void;
  view(): ActivityView | null;
  dispose(): void;
}
export const createConnectionActivity = (options: { lms: string | null; serverInfoPath: string; now: () => number }): ConnectionActivity => {
  void options;
  throw new Error('createConnectionActivity: not implemented (ad-lmstudio)');
};
