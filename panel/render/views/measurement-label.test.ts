import { expect, test } from 'bun:test';
import type { SessionMeasurement } from '../../present/session.ts';
import { measurementLabel, readoutText } from './session.ts';

const reading: SessionMeasurement = { label: 'Engine', text: '43.8', unit: 'tok/s', basis: 'reported', live: true, kind: 'speed', detail: 'All engine requests · From server · average for this request' };

test('labels name one of two layers; how a value was measured stays in its explanation', () => {
  expect(measurementLabel(reading)).toBe('Engine');
  expect(measurementLabel({ ...reading, detail: 'All engine requests · Calculated · last 4.0 s' })).toBe('Engine');
  expect(measurementLabel({ ...reading, label: 'This chat', detail: 'Estimated delivery over 3.0 s' })).toBe('This chat');
  expect(measurementLabel({ ...reading, label: 'Last reply · Engine', live: false })).toBe('Last reply · Engine');
});

test('an estimate reads with ≈ before its value; measured values and progress never do', () => {
  expect(readoutText(reading)).toBe('43.8');
  expect(readoutText({ ...reading, basis: 'estimate' })).toBe('≈ 43.8');
  expect(readoutText({ ...reading, kind: 'progress', text: '45%', unit: null })).toBe('45%');
  expect(readoutText({ ...reading, basis: 'derived' })).toBe('43.8');
});
