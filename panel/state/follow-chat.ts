import type { SessionSnapshot } from '../host/types.ts';
import { chatKey } from '../../src/contract/chat-key.ts';
import { isConnectionId } from '../../src/contract/guards.ts';
import { splitModel } from '../attribution/sessions.ts';

/** Automatic follows the chat when its numbers are known and the engine otherwise; Engine pins the whole server. */
export type MeasurementScope = 'auto' | 'engine';
/** Keeps the open session only in frame memory. Requests carry hashed identifiers; exports never read them. */
export class FollowChat {
  #identity = '';
  #current: { provider: string; chat: string; chatModel: string } | null = null;
  session: SessionSnapshot | null = null;
  update<T extends SessionSnapshot>(session: T | null): boolean {
    const identity = session ? `${session.id}\0${session.model ?? ''}` : '';
    this.session = session;
    if (identity === this.#identity) return false;
    this.#identity = identity;
    const { provider, model } = splitModel(session?.model);
    this.#current = session?.id && provider && model && isConnectionId(provider)
      ? { provider, chat: chatKey('session', session.id), chatModel: chatKey('model', model) } : null;
    return true;
  }
  query(scope: MeasurementScope, selection?: Record<string, string>): Record<string, string> | undefined {
    if (scope === 'engine' || this.session === null) return selection;
    // A chat with unknown identity is not permission to collect a different, pinned local engine.
    if (!this.#current) return { chatUnavailable: '1' };
    // A busy hint wakes a dormant cadence before the companion's first event reaches its file.
    return { ...this.#current, ...this.session?.busy ? { chatBusy: '1' } : {} }; // Runtime pins apply only to Whole engine.
  }
}
