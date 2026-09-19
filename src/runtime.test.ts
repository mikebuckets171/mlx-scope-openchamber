import { expect, test } from 'bun:test';
import { parseConnection } from './runtime.ts';
import { normalizeOmlxTelemetry, parseTelemetrySnapshot } from './telemetry.ts';

test('connection metadata and catalogs are bounded and allowlisted in connected and offline snapshots', () => {
  for (const available of [true, false]) {
    const snapshot = parseTelemetrySnapshot({ available, runtime: 'lmstudio', phase: 'unknown', sampledAt: 1000,
      connection: { selected: 'engine', label: 'My\nengine', runtime: 'lmstudio', diagnostic: 'ready', coverage: 'inventory', apiKey: 'discard-key',
        choices: Array.from({ length: 20 }, (_, index) => ({ id: `local-${index}`, label: 'x'.repeat(200), runtime: 'unsupported', baseURL: 'discard-url' })) },
      catalog: Array.from({ length: 30 }, () => ({ name: 'model', loaded: 'unknown', format: 'other', contextWindow: 0, path: 'discard-path' })) });
    expect(snapshot.connection?.choices).toHaveLength(8);
    expect(snapshot.connection?.label).toBe('Myengine');
    expect(snapshot.connection?.choices[0]).toEqual({ id: 'local-0', label: 'x'.repeat(120), runtime: null });
    expect(snapshot.catalog).toHaveLength(12);
    expect(snapshot.catalog?.[0]).toEqual({ name: 'model', loaded: null, format: null, contextWindow: null });
    expect(JSON.stringify(snapshot)).not.toContain('discard-');
  }
});

test('private oMLX model paths are reduced to labels after context matching', () => {
  const id = '/private/models/example';
  const snapshot = normalizeOmlxTelemetry(null, { active_models: { models: [{ id, active_requests: 0, waiting_requests: 0 }] } }, new Map([[id, 32768]]))!;
  expect(snapshot.contextWindow).toBe(32768);
  expect(snapshot.modelID).toBe('example');
  expect(snapshot.residentModels[0]?.id).toBe('example');
  expect(JSON.stringify(snapshot)).not.toContain('/private');
  expect(parseTelemetrySnapshot(snapshot)).toEqual(snapshot);
});

test('connection generation accepts only a bounded random UUID marker', () => {
  const generation = crypto.randomUUID();
  expect(parseConnection({ generation })?.generation).toBe(generation);
  for (const invalid of [undefined, null, 1, {}, '', 'http://127.0.0.1:8000', generation + 'extra', generation.repeat(100)]) {
    expect(parseConnection({ generation: invalid })?.generation).toBeNull();
  }
});
