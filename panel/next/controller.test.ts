import { expect, test } from 'bun:test';
import type { HostClient, HostReadyContext, HostSessions, HostShells } from '../host/types.ts';
import { NextPreferencesStore, outputTail, WorkspaceAwareness } from './controller.ts';
import { parseReadingCard } from './popover.ts';

const ready: HostReadyContext = { surface: 'panel', session: null, directory: '/fixture/project', theme: { mode: 'light', tokens: {} }, features: { deviceStorage: true } };
const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const base = (): HostClient => ({ storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
  onReady: () => () => {}, onSession: () => () => {}, onSessionLifecycle: () => () => {}, serviceRequest: async () => ({ status: 200, body: '{}' }), serviceStatus: async () => ({ status: 'ready' }),
  openSurface: async () => {}, openUrl: async () => {}, compose: async () => {}, writeClipboard: async () => {}, setBadge: async () => {}, setHeight: async () => {}, toast: async () => {}, dispose() {} });

test('missing/invalid device preferences keep both optional awareness modules off', async () => {
  const host = base(), calls: unknown[] = [];
  host.storage.get = async (...args) => { calls.push(args); return { designMode: 'future', workspace: 'true', shells: null, private: 'not retained' }; };
  const prefs = new NextPreferencesStore(host, ready); await prefs.load();
  expect(prefs.value).toEqual({ workspace: false, shells: false });
  expect(calls).toEqual([['view.next', { scope: 'device' }]]);
  const unsupported = new NextPreferencesStore(host, { ...ready, features: {} }); await unsupported.load();
  await expect(unsupported.set({ workspace: true })).rejects.toThrow('Device preferences unavailable');
  expect(calls).toHaveLength(1);
});

test('late preference loads cannot overwrite a new click; persisted data is only preferences', async () => {
  const host = base(), writes: unknown[] = [];
  let finish!: (value: { designMode: string }) => void;
  host.storage.get = () => new Promise(resolve => { finish = resolve; });
  host.storage.set = async (...args) => { writes.push(args); };
  const prefs = new NextPreferencesStore(host, ready), pending = prefs.load();
  await prefs.set({ shells: true }); finish({ designMode: 'classic' }); await pending;
  expect(prefs.value).toEqual({ workspace: false, shells: true });
  expect(writes).toEqual([['view.next', prefs.value, { scope: 'device' }]]);
});

test('device read errors remain observable unless superseded by a newer preference choice', async () => {
  const host = base();
  host.storage.get = async () => { throw new Error('Fixture read refusal'); };
  const prefs = new NextPreferencesStore(host, ready);
  await expect(prefs.load()).rejects.toThrow('Fixture read refusal');
  expect(prefs.value).toEqual({ workspace: false, shells: false });
  let refuse!: (error: Error) => void;
  host.storage.get = () => new Promise((_resolve, reject) => { refuse = reject; });
  const pending = prefs.load(); await prefs.set({ workspace: true }); refuse(new Error('Late refusal')); await pending;
  expect(prefs.value.workspace).toBe(true);
});

const setup = () => {
  const host = base(), calls = { projects: 0, sessions: 0, shells: 0, output: 0, stops: 0 };
  let sessions!: (value: HostSessions) => void, shells!: (value: HostShells) => void;
  host.onProjects = async listener => { calls.projects++; listener({ state: 'ready', projects: [{ id: 'project', name: 'Fixture', directory: '/fixture/project' }] }); return () => { calls.stops++; }; };
  host.onSessions = async (_id, listener) => { calls.sessions++; sessions = listener; return () => { calls.stops++; }; };
  host.onRunningShells = async (_scope, listener) => { calls.shells++; shells = listener; return () => { calls.stops++; }; };
  host.readShellOutput = async () => { calls.output++; return { output: 'canary-private-command-output'.repeat(1000), cursor: 10, skipped: true }; };
  const awareness = new WorkspaceAwareness(host, () => {});
  return { host, calls, awareness, sessions: (value: HostSessions) => sessions(value), shells: (value: HostShells) => shells(value) };
};
const activeShells: HostShells = { shells: [{ id: 'shell', command: 'fixture command', startedAt: 1, background: true }], ended: [] };

test('output tails keep complete multibyte characters within 8 KiB and preserve empty or short text', () => {
  const input = '🙂漢é'.repeat(3_000) + 'fixture_utf8_tail', tail = outputTail(input);
  expect(new TextEncoder().encode(tail).byteLength).toBeLessThanOrEqual(8_192);
  expect(tail.endsWith('fixture_utf8_tail')).toBe(true); expect(tail).not.toContain('\ufffd');
  expect(tail.length).toBeLessThan(input.length);
  expect(outputTail('')).toBe(''); expect(outputTail('é🙂漢')).toBe('é🙂漢');
  expect(outputTail('x'.repeat(10_000))).toBe('x'.repeat(8_192));
});

test('awareness makes no subscriptions when off/hidden, subscribes once when enabled, and disposes late registrations', async () => {
  const s = setup();
  s.awareness.configure('/fixture/project', true, false, false);
  s.awareness.configure('/fixture/project', false, true, true);
  expect(s.calls.projects).toBe(0);
  s.awareness.configure('/fixture/project', true, true, true); await tick();
  s.awareness.configure('/fixture/project', true, true, true); await tick();
  expect(s.calls).toMatchObject({ projects: 1, sessions: 1, shells: 1, output: 0 });
  s.shells(activeShells); s.sessions({ state: 'ready', sessions: [] });
  s.awareness.configure('/fixture/project', false, true, true);
  expect(s.calls.stops).toBe(3); expect(s.awareness.shells).toBeNull(); expect(s.awareness.sessions).toBeNull();
  s.shells(activeShells); expect(s.awareness.shells).toBeNull();
  s.awareness.configure('/fixture/project', true, true, true);
  s.awareness.configure('/fixture/project', false, true, true); await tick();
  expect(s.calls.stops).toBeGreaterThanOrEqual(4);
});

test('output is read only on a click, bounded and cleared on hide; unknown shell IDs cannot be read', async () => {
  const s = setup(); s.awareness.configure('/fixture/project', true, false, true); await tick(); s.shells(activeShells);
  expect(s.calls.output).toBe(0); expect(s.calls.sessions).toBe(0);
  await s.awareness.readOutput('unknown'); expect(s.calls.output).toBe(0);
  await s.awareness.readOutput('shell'); expect(s.calls.output).toBe(1); expect(s.awareness.output!.length).toBeLessThanOrEqual(8192);
  s.awareness.configure('/fixture/project', false, false, true); expect(s.awareness.output).toBeNull();
});

test('closing output or switching project discards an in-flight response', async () => {
  const s = setup(); let finish!: (value: { output: string; cursor: number; skipped: boolean }) => void;
  s.host.readShellOutput = () => new Promise(resolve => { finish = resolve; });
  s.awareness.configure('/fixture/project', true, false, true); await tick(); s.shells(activeShells);
  const pending = s.awareness.readOutput('shell'); s.awareness.clearOutput(); finish({ output: 'private', cursor: 1, skipped: false }); await pending;
  expect(s.awareness.output).toBeNull();
});

test('an active worktree resolves only within registered projects', async () => {
  const s = setup(); let reads = 0;
  s.host.listWorktrees = async id => { reads++; expect(id).toBe('project'); return { worktrees: [{ directory: '/fixture/worktree' }] }; };
  s.awareness.configure('/fixture/worktree', true, true, false); await tick(); await tick();
  expect(reads).toBe(1); expect(s.calls.sessions).toBe(1); expect(s.calls.shells).toBe(0);
  s.awareness.dispose();
});

test('popover input retains only bounded display facts, rejecting malformed or excessive payloads', () => {
  const card = { title: 'Generating', value: '42 tok/s', detail: 'Engine measurement', facts: ['Output 20'], observedAt: 10, designMode: 'next', private: 'not retained' };
  expect(parseReadingCard(card)).toEqual({ title: card.title, value: card.value, detail: card.detail, facts: card.facts, observedAt: 10 });
  expect(parseReadingCard({ ...card, facts: Array(9).fill('x') })).toBeNull();
  expect(parseReadingCard({ ...card, detail: 'x'.repeat(501) })).toBeNull();
  expect(parseReadingCard({ ...card, observedAt: NaN })).toBeNull();
});

test('a refused workspace subscription does not prevent independent shell awareness', async () => {
  const s = setup();
  s.host.onSessions = async () => { throw new Error('Fixture refusal'); };
  s.awareness.configure('/fixture/project', true, true, true); await tick(); await tick();
  expect(s.calls.shells).toBe(1);
  s.shells(activeShells); expect(s.awareness.shells).toEqual(activeShells);
  expect(s.awareness.message).toContain('approval');
  s.awareness.dispose(); expect(s.calls.stops).toBe(2);
});
