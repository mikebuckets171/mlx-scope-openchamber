import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Attribution in a real engine (Chromium and WebKit projects): marks carry the same tag in every frame and engine, so
// the service can dedupe them, and nothing on the wire or in the frame's state names the chat.
const T0 = 1_790_690_000_000;
let bundle = '';
test.beforeAll(({}, info) => {
  const root = join(info.project.testDir, '..', '..');
  bundle = execFileSync('bun', ['build', join(root, 'tests/browser/attribution-entry.ts'), '--target=browser', '--format=iife'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
});

test('tags, marks and verdicts match the Bun reference without crypto.subtle, and never name the chat', async ({ page }) => {
  await page.setContent('<!doctype html><meta charset="utf-8"><title>attribution</title>');
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(() => (window as unknown as { ScopeAttribution: { run(): {
    tags: string[]; subtle: string; sent: string[]; state: string; label: unknown; turn: number | null } } }).ScopeAttribution.run());
  expect(result.subtle).toBe('undefined');
  // src/contract/hash.test.ts pins the first; the rest were computed by Bun 1.4.2.
  expect(result.tags).toEqual(['d57f41f8', '6b0a3adb', '5d8bd760', '3429309c', '5dd07315']);
  expect(result.sent).toEqual([
    `mark=started.${T0 + 2_000}.6b0a3adb`,
    `mark=completed.${T0 + 6_300}.6b0a3adb`,
    'attr=1.inferred.-',
  ]);
  expect(result.label).toEqual({ kind: 'inferred' });
  expect(result.turn).toBe(1);
  // Model and provider names stay in the frame (class B); session ids and titles never leave the session feed.
  expect(result.sent.join('\n')).not.toMatch(/ses_fixture|secret|Qwen|splish/i);
  expect(result.state).not.toMatch(/ses_fixture|secret/i);
});
