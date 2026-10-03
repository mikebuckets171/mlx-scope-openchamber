import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Flush iframe -> host -> iframe messages between clock ticks, so every synthetic reading is actually observed.
const advance = async (page: Page, milliseconds: number): Promise<void> => {
  const panel = page.mainFrame().childFrames()[0]!;
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 500) {
    await page.clock.runFor(500);
    await panel.evaluate(() => new Promise<void>(resolve => {
      const receive = (event: MessageEvent) => {
        if (event.source !== parent || event.data !== 'design-pong') return;
        removeEventListener('message', receive); resolve();
      };
      addEventListener('message', receive); parent.postMessage('design-ping', '*');
    }));
  }
};
const screenshot = async (page: Page, path: string): Promise<void> => {
  const scope = page.frameLocator('iframe').locator('#scope');
  const size = await scope.boundingBox();
  if (!size) throw new Error('Missing preview surface');
  // An element screenshot cannot reveal content clipped by the containing iframe.
  await page.setViewportSize({ width: page.viewportSize()!.width, height: Math.ceil(size.y + size.height) + 24 });
  await scope.screenshot({ path });
};

// The same controls move between full page and rail; no extra monitoring or duplicate next-reply action.
test('next reply stays usable across page and rail layouts', async ({ page }) => {
  await page.setViewportSize({ width: 1160, height: 1000 });
  await page.goto('/v2?surface=page&state=decode&chat=local');
  const frame = page.frameLocator('iframe');
  const action = frame.getByRole('button', { name: 'Measure next reply', exact: true });
  await expect(action).toHaveCount(1);
  await expect(frame.locator('#workspace-action')).toBeVisible();
  await action.click();
  await expect(frame.locator('#workspace-action')).toContainText('Next reply · armed');
  await page.setViewportSize({ width: 430, height: 1000 });
  await expect(frame.locator('#workspace-action')).toBeHidden();
  await expect(frame.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(1);
  await expect(frame.locator('#reply-strip')).toContainText('Next reply · armed');
  await frame.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(action).toHaveCount(1);
  await page.setViewportSize({ width: 1160, height: 1000 });
  await expect(frame.locator('#workspace-action')).toBeVisible();
  await expect(action).toHaveCount(1);
});

test('design preview uses real views with isolated synthetic data and live theme controls', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewportSize({ width: 1487, height: 1170 });
  await page.clock.install({ time: Date.UTC(2026, 9, 3, 1, 0) });
  await page.addInitScript(() => {
    if (window !== window.top) return;
    addEventListener('message', event => {
      const child = document.querySelector('iframe')?.contentWindow;
      if (event.source === child && event.data === 'design-ping') child!.postMessage('design-pong', '*');
    });
  });
  await page.goto('/v2?demo=1');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#rate')).toBeVisible();
  await expect(frame.locator('.history-trend .plot')).toBeVisible();
  await expect(frame.locator('.recent-replies .led-row').first()).toBeVisible();
  await advance(page, 92_000);
  await expect(frame.locator('#signal .trace')).toHaveAttribute('d', /M.*L/);
  const evidence = process.env.SCOPE_EVIDENCE_DIR;
  if (evidence && testInfo.project.name === 'chromium') {
    await mkdir(evidence, { recursive: true });
    await screenshot(page, join(evidence, 'mlx-scope-dark.png'));
  }
  await page.getByRole('combobox', { name: 'Preview theme' }).selectOption('warm-amber');
  await expect(frame.locator('html')).toHaveAttribute('data-oc-theme', 'light');
  await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(248, 245, 238)');
  if (evidence && testInfo.project.name === 'chromium')
    await screenshot(page, join(evidence, 'mlx-scope-light.png'));
  await page.getByRole('link', { name: '430px panel' }).click();
  await expect(frame.locator('#scope')).toHaveAttribute('data-layout', 'tabs');
  await expect(frame.locator('html')).toHaveAttribute('data-oc-theme', 'light');
  await advance(page, 92_000);
  if (evidence && testInfo.project.name === 'chromium')
    await screenshot(page, join(evidence, 'mlx-scope-rail.png'));
  expect(errors).toEqual([]);
});

test('the Session widget blends into its host pane and keeps its statistics toggle', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 700, height: 600 });
  await page.goto('/v2?demo=1&surface=status&theme=obsidian');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.ws-phase')).toHaveText('Idle');
  await expect(frame.locator('.ws-model-line')).toBeVisible();
  await expect(frame.locator('.ws-alert-row')).toContainText('Memory pressure');
  await expect(frame.locator('html')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(frame.locator('body')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const evidence = process.env.SCOPE_EVIDENCE_DIR;
  if (evidence && testInfo.project.name === 'chromium') {
    await mkdir(evidence, { recursive: true });
    await page.locator('.preview-session').screenshot({ path: join(evidence, 'mlx-scope-session-dark.png') });
  }
  await frame.getByRole('button', { name: 'Show turn stats', exact: true }).click();
  await expect(frame.locator('#ws')).toHaveAttribute('data-mode', 'turn-stats');
  await page.getByRole('combobox', { name: 'Preview theme' }).selectOption('warm-amber');
  await expect(frame.locator('html')).toHaveAttribute('data-oc-theme', 'light');
  await expect(frame.locator('#ws')).toHaveAttribute('data-mode', 'turn-stats');
  await frame.getByRole('button', { name: 'Show the glance view', exact: true }).click();
  await expect(frame.locator('.ws-phase')).toHaveText('Idle');
  if (evidence && testInfo.project.name === 'chromium')
    await page.locator('.preview-session').screenshot({ path: join(evidence, 'mlx-scope-session-light.png') });
});
