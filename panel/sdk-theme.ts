// The SDK's `@openchamber/sdk/ui` entry also evaluates every UI primitive's stylesheet (≈ 17 KB the bundler cannot drop:
// its `tone()` calls might have side effects). The panel uses only the host-theme helper, so it imports that module alone,
// from the pinned SDK (2.0.4, bun.lock).
export { applyHostReady } from '../node_modules/@openchamber/sdk/dist/ui/theme.js';
