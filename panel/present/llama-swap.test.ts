import { expect, test } from 'bun:test';
import type { ConnectionV2 } from '../../src/contract/snapshot.ts';
import { connName } from './copy.ts';
import { connectionName } from './messages.ts';

const connection = (patch: Partial<ConnectionV2>): ConnectionV2 => ({ id: 'splash', label: 'Splash', runtime: 'splash', generation: 1, choices: [],
  detection: { basis: 'hint', confidence: 'medium' }, ...patch });

test('a server read through llama-swap names both, so the reading never looks like a direct connection', () => {
  expect(connName(connection({ host: 'llama-swap', engine: 'splash' }))).toBe('Splash via llama-swap');
  expect(connName(connection({}))).toBe('Splash');
  expect(connectionName('splash', { engine: 'splash', host: 'llama-swap' })).toBe('Splash via llama-swap');
  expect(connectionName('llama-server', { engine: null, host: 'llama-swap' })).toBe('llama-server via llama-swap');
});
