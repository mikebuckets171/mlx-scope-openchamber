import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('production panel SDK imports stay inside the host adapter and pinned theme boundary', async () => {
  const panel = new URL('../', import.meta.url), leaks: string[] = [];
  for (const path of await readdir(panel, { recursive: true })) {
    if (!path.endsWith('.ts') || path.endsWith('.test.ts') || path.startsWith('testing/') || path === 'attribution/testing.ts' || path.startsWith('host/') || path === 'sdk-theme.ts') continue;
    const source = await readFile(join(panel.pathname, path), 'utf8');
    if (/from\s+['"][^'"]*@openchamber\/sdk/.test(source)) leaks.push(path);
  }
  expect(leaks).toEqual([]);
});

test('the background command keeps its SDK imports in its on-demand host adapter', async () => {
  const background = new URL('../../background/', import.meta.url), leaks: string[] = [];
  for (const path of await readdir(background)) {
    if (!path.endsWith('.ts') || path.endsWith('.test.ts') || path === 'host.ts') continue;
    if (/from\s+['"][^'"]*@openchamber\/sdk/.test(await readFile(join(background.pathname, path), 'utf8'))) leaks.push(path);
  }
  expect(leaks).toEqual([]);
});
