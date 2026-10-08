import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { chatKey } from './chat-key.ts';

test('guest matching keys equal companion SHA-256 across UTF-8 and block boundaries', () => {
  for (const kind of ['session', 'provider', 'model', 'endpoint'] as const) {
    for (const value of ['', 'ses_example', 'provider/model/子🦊', 'a'.repeat(55), 'x'.repeat(256), '\ud800']) {
      expect(chatKey(kind, value)).toBe(createHash('sha256').update(`mlx-scope-${kind}-v1\0${value}`).digest('hex'));
    }
  }
});
