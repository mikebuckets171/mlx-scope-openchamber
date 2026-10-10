import { expect, test } from 'bun:test';
import { parseConnections } from './connections-view.ts';

test('connection metadata is rebuilt from public fields and rejects malformed choices', () => {
  expect(parseConnections({ schemaVersion: 1, state: 'ready', choices: [{ id: 'local', label: 'Local server', runtime: null, credential: 'never-render' }] })).toEqual({ state: 'ready', choices: [{ id: 'local', label: 'Local server', runtime: null }] });
  expect(parseConnections({ schemaVersion: 1, state: 'ready', choices: [{ id: 'local', label: 'Local server', runtime: 'invented' }] })).toBeNull();
  expect(parseConnections({ schemaVersion: 1, state: 'ready', choices: Array(9).fill({ id: 'local', label: 'Local', runtime: 'omlx' }) })).toBeNull();
  expect(parseConnections({ schemaVersion: 1, state: 'unavailable', choices: [] })).toEqual({ state: 'unavailable', choices: [] });
});
