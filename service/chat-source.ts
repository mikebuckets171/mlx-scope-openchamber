import { chatKey } from '../src/contract/chat-key.ts';
import type { ChatTelemetry } from './chat-telemetry.ts';
import type { RuntimeClient } from './runtime-client.ts';
import type { Sources } from './server.ts';

/** No provider-name guess and no runtime request: a configured loopback target is the only proof of locality. */
export const createChatDestination = (client: Pick<RuntimeClient, 'companionTarget'>): NonNullable<Sources['chatDestination']> =>
  async query => query.provider && await client.companionTarget(query.provider) ? 'local' : 'remote';

/** Exact selected-chat matching. Remote demand never consults local runtime configuration or endpoints. */
export const createChatSource = (chat: Pick<ChatTelemetry, 'observe'>,
  client: Pick<RuntimeClient, 'companionTarget'>): NonNullable<Sources['chat']> => async (query, reading) => {
  if (!query.frame || query.surface === 'background') return null;
  // A selected cloud chat observes only its own delivery through OpenCode. It never reads local runtime state,
  // borrows a local endpoint or reuses a local engine measurement; the companion corroborates the remote origin.
  if (query.chatOnly && query.chat && query.chatModel && query.provider)
    return chat.observe(query.frame, { sessionKey: query.chat, modelKey: query.chatModel,
      providerKey: chatKey('provider', query.provider), destination: 'remote' });
  const target = query.chat && query.chatModel && query.provider && reading.meta.connection.id === query.provider
    ? await client.companionTarget(query.provider) : null;
  return chat.observe(query.frame, target ? { ...target, sessionKey: query.chat!, modelKey: query.chatModel! } : null);
};
