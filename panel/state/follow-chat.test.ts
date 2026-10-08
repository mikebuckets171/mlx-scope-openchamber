import { expect, test } from 'bun:test';
import { FollowChat } from './follow-chat.ts';

test('This chat follows the selected provider, without exposing raw identifiers or a pinned runtime', () => {
  const follow = new FollowChat();
  expect(follow.update({ id:'ses_private', title:'Private title', busy:true, model:'custom-local/namespace/model' })).toBe(true);
  const query = follow.query('chat', { provider:'old', runtime:'omlx' })!;
  expect(query.provider).toBe('custom-local');
  expect(query.chatBusy).toBe('1');
  expect(query.runtime).toBeUndefined();
  expect(query.chat).toMatch(/^[a-f0-9]{64}$/);
  expect(query.chatModel).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(query)).not.toContain('ses_private');
  expect(JSON.stringify(query)).not.toContain('namespace/model');
  expect(follow.update({ id:'ses_private', title:'Changed title', busy:false, model:'custom-local/namespace/model' })).toBe(false);
  expect(follow.query('chat')?.chatBusy).toBeUndefined();
  expect(follow.update({ id:'ses_other', title:'', busy:true, model:'custom-local/namespace/model' })).toBe(true);
});
test('Whole engine preserves selection; opening a full page without a chat remains usable', () => {
  const follow = new FollowChat(), selection = { provider:'pinned', runtime:'splash' };
  expect(follow.query('chat', selection)).toEqual(selection);
  follow.update({ id:'s', title:'', busy:true, model:'local/model' });
  expect(follow.query('engine', selection)).toEqual(selection);
  expect(follow.update(null)).toBe(true);
  expect(follow.query('chat', selection)).toEqual(selection);
});
