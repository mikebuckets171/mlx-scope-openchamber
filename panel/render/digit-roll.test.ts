import { expect, test } from 'bun:test';
import { changedDigits, digitMarkup } from './digit-roll.ts';
test('digit motion uses only changed actual digits with stable format', () => {
  expect(changedDigits('24.8', '25.1')).toEqual([1, 3]);
  expect(changedDigits('24.8', '24.8')).toEqual([]);
  for (const [a, b] of [['9.9', '10.0'], ['1,000', '1.000'], ['99%', '100%'], ['1.0K', '1.0M']]) expect(changedDigits(a!, b!)).toEqual([]);
});
test('digit markup is escaped and leaves its accessible value to the parent', () => {
  expect(digitMarkup('24.8').markup).toContain('data-digit="3" aria-hidden="true"');
  expect(digitMarkup('<').markup).toContain('&lt;');
  expect(digitMarkup('24.8').markup).not.toContain('aria-live');
});
