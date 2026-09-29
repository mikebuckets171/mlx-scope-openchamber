import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';

// P5: the service does work only when a view asks. One-shot timers (deadlines, idle stops, restart backoff) are fine;
// a repeating timer would read or spawn with nobody watching.
test('no setInterval anywhere in the service sources or the shipped bundle', () => {
  const root = new URL('.', import.meta.url).pathname;
  const sources = [...new Glob('**/*.ts').scanSync(root)].filter(file => !file.endsWith('.test.ts'));
  expect(sources.length).toBeGreaterThan(20);
  for (const file of [...sources, 'main.js']) expect(readFileSync(`${root}${file}`, 'utf8'), file).not.toMatch(/\bsetInterval\b/);
});
