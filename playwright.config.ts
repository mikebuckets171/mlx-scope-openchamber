import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser', testMatch: /(?:preview|[^/]+\.spec)\.ts$/, timeout: 30_000,
  expect: { timeout: 5_000 }, fullyParallel: false, workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:8787', contextOptions: { reducedMotion: 'reduce' }, trace: 'retain-on-failure' },
  webServer: {
    command: 'bun tests/browser/server.ts', url: 'http://127.0.0.1:8787',
    reuseExistingServer: !process.env.CI, timeout: 15_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } }],
});
