import { expect, test } from 'bun:test';
import type { SessionMeasurement } from '../../present/session.ts';
import { measurementLabel } from './session.ts';

const reading: SessionMeasurement = { label: 'Engine', text: '43.8', unit: 'tok/s', basis: 'reported', live: true, kind: 'speed', detail: 'All engine requests · From server · average for this request' };

test('Next exposes request-average and recent-window qualifiers from the presented detail', () => {
  expect(measurementLabel(reading, true)).toBe('Engine · request average');
  expect(measurementLabel({ ...reading, detail: 'All engine requests · Calculated · last 4.0 s' }, true)).toBe('Engine · recent 4.0 s');
  expect(measurementLabel({ ...reading, label: 'Chat · est.', detail: 'Estimated delivery over 3.0 s' }, true)).toBe('Chat · est.');
  expect(measurementLabel({ ...reading, label: 'Last engine · avg.', live: false }, true)).toBe('Last engine · avg.');
  expect(measurementLabel({ ...reading, kind: 'progress' }, true)).toBe('Engine');
  expect(measurementLabel(reading)).toBe('Engine');
});
