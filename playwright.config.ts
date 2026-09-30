import { defineConfig } from '@playwright/test';

// The 2.0 goldens run only when named (`bun run test:goldens`), in Chromium, and stay out of `test:browser`.
// The flag is exported so worker processes load the same configuration. GOLDENS_UPDATE=1 regenerates them.
const GOLDENS = /goldens\.spec\.ts$/;
const goldens = process.env.GOLDENS_RUN === '1' || process.argv.some(arg => GOLDENS.test(arg));
if (goldens) process.env.GOLDENS_RUN = '1';
// SCOPE_PREVIEW_PORT lets parallel worktrees each run their own preview server; exported for the workers like GOLDENS_RUN.
const port = Number(process.env.SCOPE_PREVIEW_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error('SCOPE_PREVIEW_PORT must be an integer from 1024 to 65535.');
process.env.SCOPE_PREVIEW_PORT = String(port);
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/browser', testMatch: /(?:preview|[^/]+\.spec)\.ts$/, timeout: 30_000,
  expect: { timeout: 5_000 }, fullyParallel: false, workers: 1,
  reporter: 'list',
  ...(goldens ? { updateSnapshots: process.env.GOLDENS_UPDATE === '1' ? 'changed' as const : 'none' as const } : {}),
  use: { baseURL: origin, contextOptions: { reducedMotion: 'reduce' }, trace: 'retain-on-failure' },
  webServer: {
    command: 'bun tests/browser/server.ts', url: origin, env: { SCOPE_PREVIEW_PORT: String(port) },
    reuseExistingServer: !process.env.CI, timeout: 15_000,
  },
  projects: [{ name: 'chromium', testIgnore: GOLDENS, use: { browserName: 'chromium' } },
    { name: 'webkit', testIgnore: GOLDENS, use: { browserName: 'webkit' } },
    { name: 'goldens', testMatch: GOLDENS, testIgnore: goldens ? [] : GOLDENS, use: { browserName: 'chromium' },
      snapshotPathTemplate: '{testDir}/../goldens/2.0/{arg}{ext}',
      expect: { timeout: 10_000, toHaveScreenshot: { threshold: 0, maxDiffPixels: 0, animations: 'disabled', caret: 'hide', scale: 'css' } } }],
});
