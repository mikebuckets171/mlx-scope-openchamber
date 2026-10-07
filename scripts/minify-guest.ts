// The SDK links the browser IIFE first. A final pass with pinned Bun 1.4.2 folds the linked code while
// retaining all UI explanations within the guest bundle ceilings. This does not change the service build.
const path = process.argv[2];
if (!path) throw new Error('Usage: bun scripts/minify-guest.ts <guest-bundle.js>');
const result = await Bun.build({ entrypoints: [path], target: 'browser', format: 'iife', minify: true });
if (!result.success) throw new Error(result.logs.map(log => log.message).join('\n') || 'Guest minification failed.');
const output = result.outputs[0];
if (!output) throw new Error('Guest minification produced no bundle.');
await Bun.write(path, output);

export {};
