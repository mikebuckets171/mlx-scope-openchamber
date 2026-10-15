import { minify } from 'terser';
import { internStrings } from './intern-strings.ts';

// The SDK links the browser IIFE first. A pinned, conservative compression pass keeps the guest ceilings without
// changing property names used by the host bridge or the service build. Repeated string values share lexical constants;
// there is no runtime decoder. Enclosing the result preserves frame-local scope, including the shared values.
export const minifyGuest = async (source: string): Promise<string> => {
  const result = await minify(source, { ecma: 2022, enclose: true, compress: { passes: 2 },
    mangle: { properties: false }, format: { comments: false } });
  if (!result.code?.trim()) throw new Error('Guest minification produced no bundle.');
  const pooled = internStrings(result.code);
  if (pooled === result.code) return result.code;
  const final = await minify(pooled, { ecma: 2022, enclose: true, compress: false,
    mangle: { properties: false }, format: { comments: false } });
  if (!final.code?.trim()) throw new Error('Guest string pooling produced no bundle.');
  return final.code.length < result.code.length ? final.code : result.code;
};

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: bun scripts/minify-guest.ts <guest-bundle.js>');
  const output = await minifyGuest(await Bun.file(path).text());
  await Bun.write(path, output);
}
