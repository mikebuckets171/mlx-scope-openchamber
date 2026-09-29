import { defineConfig } from '@playwright/test';

// The 1.6 goldens run only when named (`bun run test:goldens`), in Chromium, and stay out of `test:browser`.
// The flag is exported so worker processes load the same configuration. GOLDENS_UPDATE=1 regenerates them.
const GOLDENS = /goldens\.spec\.ts$/;
const goldens = process.env.GOLDENS_RUN === '1' || process.argv.some(arg => GOLDENS.test(arg));
if (goldens) process.env.GOLDENS_RUN = '1';

export default defineConfig({
  testDir: './tests/browser', testMatch: /(?:preview|[^/]+\.spec)\.ts$/, timeout: 30_000,
  expect: { timeout: 5_000 }, fullyParallel: false, workers: 1,
  reporter: 'list',
  ...(goldens ? { updateSnapshots: process.env.GOLDENS_UPDATE === '1' ? 'changed' as const : 'none' as const } : {}),
  use: { baseURL: 'http://127.0.0.1:8787', contextOptions: { reducedMotion: 'reduce' }, trace: 'retain-on-failure' },
  webServer: {
    command: 'bun tests/browser/server.ts', url: 'http://127.0.0.1:8787',
    reuseExistingServer: !process.env.CI, timeout: 15_000,
  },
  projects: [{ name: 'chromium', testIgnore: GOLDENS, use: { browserName: 'chromium' } },
    { name: 'webkit', testIgnore: GOLDENS, use: { browserName: 'webkit' } },
    { name: 'goldens', testMatch: GOLDENS, testIgnore: goldens ? [] : GOLDENS, use: { browserName: 'chromium' },
      snapshotPathTemplate: '{testDir}/../goldens/1.6/{arg}{ext}',
      expect: { timeout: 10_000, toHaveScreenshot: { threshold: 0, maxDiffPixels: 0, animations: 'disabled', caret: 'hide', scale: 'css' } } }],
});
