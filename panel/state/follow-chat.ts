import type { SessionSnapshot } from '@openchamber/sdk';
import { chatKey } from '../../src/contract/chat-key.ts';
import { isConnectionId } from '../../src/contract/guards.ts';
import { splitModel } from '../attribution/sessions.ts';

export type MeasurementScope = 'chat' | 'engine';
/** Keeps the open session only in frame memory. Requests carry hashed identifiers; exports never read them. */
export class FollowChat {
  private identity = '';
  private current: { provider: string; chat: string; chatModel: string } | null = null;
  session: SessionSnapshot | null = null;
  update(session: SessionSnapshot | null): boolean {
    const identity = session ? `${session.id}\0${session.model ?? ''}` : '';
    this.session = session;
    if (identity === this.identity) return false;
    this.identity = identity;
    const { provider, model } = splitModel(session?.model);
    this.current = session && provider && model && isConnectionId(provider)
      ? { provider, chat: chatKey('session', session.id), chatModel: chatKey('model', model) } : null;
    return true;
  }
  query(scope: MeasurementScope, selection?: Record<string, string>): Record<string, string> | undefined {
    if (scope === 'engine' || !this.current) return selection;
    // A busy hint wakes a dormant cadence before the companion's first event reaches its file.
    return { ...this.current, ...this.session?.busy ? { chatBusy: '1' } : {} }; // Runtime pins apply only to Whole engine.
  }
}
