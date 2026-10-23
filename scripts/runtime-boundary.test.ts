import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

test('shipping entrypoints never import test fixtures or the retired v1 conversion path', () => {
  const root = resolve(import.meta.dir, '..'), seen = new Set<string>();
  const pending = ['panel/main.ts', 'service/main.ts'].map(file => resolve(root, file));
  const parser = new Bun.Transpiler({ loader: 'ts' });
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    expect(file).not.toMatch(/\/(?:tests|testing)\/|\/(?:telemetry|convert-v1)\.ts$/);
    for (const item of parser.scanImports(readFileSync(file, 'utf8'))) {
      if (!item.path.startsWith('.') || !/\.[tj]s$/.test(item.path)) continue;
      pending.push(resolve(dirname(file), item.path));
    }
  }
  expect(seen.size).toBeGreaterThan(100);
  expect(existsSync(resolve(root, 'src/telemetry.ts'))).toBe(false);
  expect(existsSync(resolve(root, 'src/contract/convert-v1.ts'))).toBe(false);
});
