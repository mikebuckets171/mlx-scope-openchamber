import { minify } from 'terser';

// The SDK links the browser IIFE first. A pinned, conservative compression pass keeps the guest ceilings without
// changing property names used by the host bridge or the service build. Enclosing the result preserves frame-local scope.
export const minifyGuest = async (source: string): Promise<string> => {
  const result = await minify(source, { ecma: 2022, enclose: true, compress: { passes: 2 },
    mangle: { properties: false }, format: { comments: false } });
  if (!result.code?.trim()) throw new Error('Guest minification produced no bundle.');
  return result.code;
};

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: bun scripts/minify-guest.ts <guest-bundle.js>');
  const output = await minifyGuest(await Bun.file(path).text());
  await Bun.write(path, output);
}
