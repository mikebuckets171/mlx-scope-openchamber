/**
 * Pure-JS tag hash for turn marks (contract §7). `crypto.subtle` is not guaranteed in guest frames, and the tag only
 * has to be stable within one service instance and unlinkable across instances, which the salt provides. A 32-bit
 * tag cannot be reversed into the session id it came from. Neither the id nor the tag is ever stored or echoed.
 */
const utf8 = function* (text: string): Generator<number> {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) yield code;
    else if (code < 0x800) { yield 0xc0 | code >> 6; yield 0x80 | code & 0x3f; }
    else if (code < 0x10000) { yield 0xe0 | code >> 12; yield 0x80 | code >> 6 & 0x3f; yield 0x80 | code & 0x3f; }
    else { yield 0xf0 | code >> 18; yield 0x80 | code >> 12 & 0x3f; yield 0x80 | code >> 6 & 0x3f; yield 0x80 | code & 0x3f; }
  }
};

/** FNV-1a over UTF-8, then the murmur3 finalizer so nearby inputs do not share prefixes. */
export const hash32 = (text: string): number => {
  let hash = 0x811c9dc5;
  for (const byte of utf8(text)) hash = Math.imul(hash ^ byte, 0x01000193);
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35);
  return (hash ^ hash >>> 16) >>> 0;
};

/** `tag8` for a session, salted with `service.instance`. */
export const tag8 = (sessionId: string, instance: string): string =>
  hash32(`${instance}\u0000${sessionId}`).toString(16).padStart(8, '0');
