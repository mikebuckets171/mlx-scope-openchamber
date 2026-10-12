import { minifyGuest } from './minify-guest.ts';

// Build in memory with the existing production settings. Qualification must not silently repair stale artifacts.
for (const target of ['panel', 'service', 'background']) {
  const guest = target !== 'service', path = `${target}/main.js`;
  const result = await Bun.build({ entrypoints: [`./${target}/main.ts`], format: guest ? 'iife' : 'esm',
    target: guest ? 'browser' : 'node', minify: true });
  if (!result.success || result.outputs.length !== 1) throw new Error(`${target} source build did not produce one artifact.`);
  const source = await result.outputs[0]!.text(), built = guest ? await minifyGuest(source) : source;
  if (built !== await Bun.file(path).text()) throw new Error(`${path} differs from its current source. Run the normal build before qualification.`);
}
console.log('PASS: panel, service and background artifacts match in-memory production builds.');
