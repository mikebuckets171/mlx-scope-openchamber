import { join } from 'node:path';
const root = join(import.meta.dir, '../..');
const allow = new Map([
  ['/', 'tests/browser/host.html'],
  ['/panel/index.html', 'panel/index.html'],
  ['/panel/main.js', 'panel/main.js'],
  ['/panel/style.css', 'panel/style.css'],
]);
const server = Bun.serve({
  hostname: '127.0.0.1', port: 8787,
  fetch(request) {
    const path = allow.get(new URL(request.url).pathname);
    if (!path) return new Response('Not found', { status: 404 });
    return new Response(Bun.file(join(root, path)), { headers: { 'Cache-Control': 'no-store' } });
  },
});
console.log(`Synthetic MLX Scope preview: ${server.url}`);
