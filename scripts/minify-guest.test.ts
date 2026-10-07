import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { minifyGuest } from './minify-guest.ts';

test('guest compression is deterministic and preserves bridge keys, getter reads and frame-local variables', async () => {
  const source = `(() => {
    let reads = 0;
    const rates = { get promptTps() { reads += 1; return 1200; }, promptWindowMs: 2350, decodeTps: 43.8, windowMs: 4000 };
    capture({ rates: { ...rates }, getter: rates.promptTps, reads });
  })();`;
  const run = (code: string) => {
    const results: unknown[] = [], context = { capture: (value: unknown) => results.push(value) };
    runInNewContext(code, context);
    return { results: JSON.parse(JSON.stringify(results)), globals: Object.keys(context) };
  };
  const compressed = await minifyGuest(source);
  expect(await minifyGuest(source)).toBe(compressed);
  expect(compressed.length).toBeLessThan(source.length);
  expect(run(compressed)).toEqual(run(source));
  expect(run(compressed).globals).toEqual(['capture']);
});

test('a dynamic SDK script still works after function compression', async () => {
  const source = `(() => {
    function install(document) { document.installed += 1; }
    capture('(' + install.toString() + ')(document);');
  })();`;
  const scripts: string[] = [];
  runInNewContext(await minifyGuest(source), { capture: (script: string) => scripts.push(script) });
  const document = { installed: 0 };
  runInNewContext(scripts[0]!, { document });
  expect(document.installed).toBe(1);
});

test('parse failure never overwrites the SDK bundle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-minify-'));
  try {
    const path = join(dir, 'guest.js'), source = '(() => { invalid syntax } )();';
    await writeFile(path, source);
    const process = Bun.spawn([Bun.which('bun')!, join(import.meta.dir, 'minify-guest.ts'), path], { stdout: 'pipe', stderr: 'pipe' });
    const [exitCode] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    expect(exitCode).not.toBe(0);
    expect(await readFile(path, 'utf8')).toBe(source);
    await expect(minifyGuest('')).rejects.toThrow('no bundle');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
