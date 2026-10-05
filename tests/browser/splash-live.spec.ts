import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// Runtime snapshots, never inference. Exercise the actual guest UI and host theme messages.
test('Splish/Splash live rate stays server-wide and clears when the source stops reporting it', async ({ page }) => {
  await page.goto('/v2?surface=page&state=splash-decode');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#rate')).toHaveText('43.8');
  await expect(frame.locator('#attribution')).toContainText('Server-wide');
  await expect(frame.locator('.readout[data-basis="derived"]')).toContainText('Live server throughput');
  await expect(frame.locator('.basis-line')).toContainText('Derived from Splash counters');
  await frame.getByRole('button', { name: 'About Live server throughput', exact: true }).click();
  await expect(frame.locator('#pop-live-basis')).toContainText('not one chat');
  await page.evaluate(() => (window as any).setPreviewState('splash-measuring'));
  await expect(frame.locator('.rate-unit')).toHaveCount(0);
  await expect(frame.locator('#hero')).not.toContainText('43.8');
  await page.evaluate(() => (window as any).setPreviewState('splash-decode'));
  await expect(frame.locator('#rate')).toHaveText('43.8');
  await expect(frame.locator('#signal .plot')).toHaveAttribute('aria-label', /server-wide/i);
  await page.evaluate(() => (window as any).setPreviewState('splash-stale'));
  await expect(frame.locator('.rate-unit')).toHaveCount(0);
  await page.evaluate(() => (window as any).setPreviewState('idle'));
  await expect(frame.locator('.reply-prominent')).toContainText('Last reply');
  await expect(frame.locator('.reply-prominent')).not.toContainText('43.8');
  await expect(frame.locator('#rate')).toHaveCount(0);
});

test('the Session pane shows live derived tok/s and follows theme changes', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 700, height: 500 });
  await page.goto('/v2?demo=1&surface=status&state=splash-decode&theme=graphite-mint');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.ws-rate')).toContainText('tok/s');
  await expect(frame.locator('.ws-model-line')).toContainText('Server-wide');
  await expect(frame.locator('#ws')).toContainText('derived');
  const rate = await frame.locator('.ws-rate').innerText();
  await expect.poll(() => frame.locator('.ws-rate').innerText()).not.toBe(rate);
  const evidence = process.env.SCOPE_EVIDENCE_DIR;
  if (evidence && testInfo.project.name === 'chromium') {
    await mkdir(evidence, { recursive: true });
    await page.locator('.preview-session').screenshot({ path: join(evidence, 'mlx-scope-splash-session.png') });
  }
  await page.getByRole('combobox', { name: 'Preview theme' }).selectOption('warm-amber');
  await expect(frame.locator('html')).toHaveAttribute('data-oc-theme', 'light');
  await expect(frame.locator('.ws-rate')).toContainText('tok/s');
  await page.evaluate(() => (window as any).setPreviewState('splash-measuring'));
  await expect(frame.locator('.ws-rate')).toHaveCount(0);
  await expect(frame.locator('#ws')).not.toContainText('tok/s');
});
