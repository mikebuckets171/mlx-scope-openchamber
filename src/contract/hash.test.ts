import { expect, test } from 'bun:test';
import { HEX8 } from './guards.ts';
import { hash32, tag8 } from './hash.ts';

// Reference: the same FNV-1a + finalizer over the platform's own UTF-8 encoder.
const reference = (text: string): number => {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 0x01000193);
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35);
  return (hash ^ hash >>> 16) >>> 0;
};

test('hash32 is a stable 32-bit value over UTF-8', () => {
  // Fixed vectors: a change here changes every tag a running service deduplicates against.
  expect([hash32(''), hash32('a'), hash32('session'), hash32('é'), hash32('😀')].map(value => value.toString(16)))
    .toEqual(['ab3e7c0b', '1a80b1b3', '7394e1e0', '8e4756c7', '3303a80a']);
  for (const text of ['', 'ses_01', 'é', 'e\u0301', '\u07ff\u0800\uffff', '😀🏳️‍🌈', 'x'.repeat(10_000), '\u0000\u007f\u0080']) {
    expect(hash32(text), JSON.stringify(text)).toBe(reference(text));
  }
  expect(hash32('é')).not.toBe(hash32('e\u0301'));
  expect(hash32('ab')).not.toBe(hash32('ba'));
});

test('tag8 is 8 lower-case hex, salted by the service instance, and never contains the session id', () => {
  const session = 'ses_fixture0001';
  const tag = tag8(session, '5c1e0a7b');
  expect(tag).toMatch(HEX8);
  expect(tag8(session, '5c1e0a7b')).toBe(tag);
  expect(tag8(session, '5c1e0a7c')).not.toBe(tag);
  expect(tag8('ses_fixture0002', '5c1e0a7b')).not.toBe(tag);
  expect(tag).not.toContain(session.slice(-8));
});

test('tags spread without collisions across many sessions', () => {
  const tags = new Set(Array.from({ length: 5_000 }, (_, index) => tag8(`ses_${index.toString(36)}`, '5c1e0a7b')));
  expect(tags.size).toBe(5_000);
  const bits = Array.from({ length: 32 }, (_, bit) => [...tags].filter(tag => (parseInt(tag, 16) >>> bit & 1) === 1).length / tags.size);
  for (const share of bits) expect(Math.abs(share - 0.5)).toBeLessThan(0.05);
});

test('works where crypto.subtle is missing', () => {
  const own = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
  Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });
  try {
    expect(globalThis.crypto.subtle).toBeUndefined();
    expect(tag8('ses_fixture0001', '5c1e0a7b')).toBe('d57f41f8');
  } finally {
    if (own) Object.defineProperty(globalThis.crypto, 'subtle', own);
    else delete (globalThis.crypto as { subtle?: unknown }).subtle;
  }
});
