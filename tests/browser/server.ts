import { join } from 'node:path';
const root = join(import.meta.dir, '../..');
const port = Number(process.env.SCOPE_PREVIEW_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error('SCOPE_PREVIEW_PORT must be an integer from 1024 to 65535.');
const allow = new Map([
  ['/', 'tests/browser/host.html'],
  ['/v2', 'tests/browser/v2-host.html'],
  ['/history.html', 'tests/browser/history.html'],
  ['/panel/index.html', 'panel/index.html'],
  ['/panel/main.js', 'panel/main.js'],
  ['/panel/style.css', 'panel/style.css'],
  ['/background/index.html', 'background/index.html'],
  ['/background/main.js', 'background/main.js'],
]);
// host.html converts its 1.x fixtures with the real v1 → v2 bridge, bundled once at startup and never written to disk.
const convert = await Bun.build({ entrypoints: [join(import.meta.dir, 'convert-entry.ts')], format: 'iife', target: 'browser' });
if (!convert.success || !convert.outputs[0]) throw new AggregateError(convert.logs, 'Could not bundle the v1 → v2 converter for the preview host.');
const converter = await convert.outputs[0].text();
// v2-host.html serves the approved mock's v2 states (panel/testing/mock-states.ts), bundled the same way.
const states = await Bun.build({ entrypoints: [join(import.meta.dir, 'v2-states-entry.ts')], format: 'iife', target: 'browser' });
if (!states.success || !states.outputs[0]) throw new AggregateError(states.logs, 'Could not bundle the mock states for the 2.0 fixture host.');
const statesScript = await states.outputs[0].text();
const media = await Bun.build({ entrypoints: [join(import.meta.dir, 'media-fixtures.ts')], format: 'iife', target: 'browser' });
if (!media.success || !media.outputs[0]) throw new AggregateError(media.logs, 'Could not bundle media fixtures.');
const mediaScript = await media.outputs[0].text();
// History's isolated fixtures use the same complete stylesheet as the product.
const history = await Bun.build({ entrypoints: [join(import.meta.dir, 'history-entry.ts')], format: 'iife', target: 'browser' });
if (!history.success || !history.outputs[0]) throw new AggregateError(history.logs, 'Could not bundle the History preview.');
const historyScript = await history.outputs[0].text();
const server = Bun.serve({
  hostname: '127.0.0.1', port,
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/media-fixtures.js') return new Response(mediaScript, { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/javascript; charset=utf-8' } });
    if (pathname === '/convert-v1.js') return new Response(converter, { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/javascript; charset=utf-8' } });
    if (pathname === '/v2-states.js') return new Response(statesScript, { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/javascript; charset=utf-8' } });
    if (pathname === '/history.js') return new Response(historyScript, { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/javascript; charset=utf-8' } });
    if (pathname === '/history.css') return new Response(Bun.file(join(root, 'panel/style.css')), { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/css; charset=utf-8' } });
    const path = allow.get(pathname);
    if (!path) return new Response('Not found', { status: 404 });
    return new Response(Bun.file(join(root, path)), { headers: { 'Cache-Control': 'no-store' } });
  },
});
console.log(`Synthetic MLX Scope preview: ${server.url}`);
