import type { ChatTelemetry } from './chat-telemetry.ts';
import type { RuntimeClient } from './runtime-client.ts';
import type { Sources } from './server.ts';

/** No provider-name guess and no runtime request: a configured loopback target is the only proof of locality. */
export const createChatDestination = (client: Pick<RuntimeClient, 'companionTarget'>): NonNullable<Sources['chatDestination']> =>
  async query => query.provider && await client.companionTarget(query.provider) ? 'local' : 'remote';

/** Exact local selected-chat matching. Cloud views release demand without observing output. */
export const createChatSource = (chat: Pick<ChatTelemetry, 'observe'>,
  client: Pick<RuntimeClient, 'companionTarget'>): NonNullable<Sources['chat']> => async (query, reading) => {
  if (!query.frame || query.surface === 'background') return null;
  if (query.chatOnly) { await chat.observe(query.frame, null); return null; }
  const target = query.chat && query.chatModel && query.provider && reading.meta.connection.id === query.provider
    ? await client.companionTarget(query.provider) : null;
  return chat.observe(query.frame, target ? { ...target, sessionKey: query.chat!, modelKey: query.chatModel! } : null);
};
