import { join } from 'node:path';
const root = join(import.meta.dir, '../..');
const allow = new Map([
  ['/', 'tests/browser/host.html'],
  ['/panel/index.html', 'panel/index.html'],
  ['/panel/main.js', 'panel/main.js'],
  ['/panel/style.css', 'panel/style.css'],
]);
// host.html converts its 1.x fixtures with the real v1 → v2 bridge, bundled once at startup and never written to disk.
const convert = await Bun.build({ entrypoints: [join(import.meta.dir, 'convert-entry.ts')], format: 'iife', target: 'browser' });
if (!convert.success || !convert.outputs[0]) throw new AggregateError(convert.logs, 'Could not bundle the v1 → v2 converter for the preview host.');
const converter = await convert.outputs[0].text();
const server = Bun.serve({
  hostname: '127.0.0.1', port: 8787,
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/convert-v1.js') return new Response(converter, { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/javascript; charset=utf-8' } });
    const path = allow.get(pathname);
    if (!path) return new Response('Not found', { status: 404 });
    return new Response(Bun.file(join(root, path)), { headers: { 'Cache-Control': 'no-store' } });
  },
});
console.log(`Synthetic MLX Scope preview: ${server.url}`);
