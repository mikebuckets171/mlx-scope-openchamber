import { expect, test } from 'bun:test';
import { serviceExplanation } from './connection-help.ts';

test('service health is distinct from runtime availability', () => {
  expect(serviceExplanation('ready')).toContain('If readings are missing');
  expect(serviceExplanation('starting')).toContain('starting');
  expect(serviceExplanation('stopped')).toContain('stopped');
  expect(serviceExplanation('failed')).toContain('could not start');
});
