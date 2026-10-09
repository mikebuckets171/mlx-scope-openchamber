import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { inspect } from './ui-checks.ts';

// Runtime snapshots, never inference. Exercise the actual guest UI and host theme messages.
test('Splish/Splash live rate stays server-wide and clears when the source stops reporting it', async ({ page }) => {
  await page.goto('/v2?surface=page&state=splash-decode');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#rate')).toHaveText('43.8');
  await expect(frame.locator('#attribution')).toContainText('All server activity');
  await expect(frame.locator('[data-stage="generation"][data-basis="derived"]')).toContainText('Generation');
  await expect(frame.locator('[data-stage="generation"] .speed-source')).toContainText('Calculated');
  await expect(frame.locator('[data-stage="generation"] .speed-source')).toContainText('last 4.0 s');
  if (!(await frame.locator('#measurement-details').evaluate(el => (el as HTMLDetailsElement).open))) await frame.locator('#measurement-details > summary').click();
  await frame.locator('#engine-readings > summary').click();
  await frame.getByRole('button', { name: 'About How engine speeds are measured', exact: true }).click();
  await expect(frame.locator('#pop-live-basis')).toContainText('Engine speed is not chat delivery.');
  await page.evaluate(() => (window as any).setPreviewState('splash-measuring'));
  await expect(frame.locator('[data-stage="generation"] .speed-value > span')).toHaveCount(0);
  await expect(frame.locator('#hero')).toContainText('Measuring…');
  await expect(frame.locator('#hero')).not.toContainText('43.8');
  await page.evaluate(() => (window as any).setPreviewState('splash-decode'));
  await expect(frame.locator('#rate')).toHaveText('43.8');
  await expect(frame.locator('#signal .plot')).toHaveAttribute('aria-label', /all server activity/i);
  await page.evaluate(() => (window as any).setPreviewState('splash-stale'));
  await expect(frame.locator('[data-stage="generation"] .speed-value > span')).toHaveCount(0);
  await page.evaluate(() => (window as any).setPreviewState('idle'));
  await expect(frame.locator('#last-reply')).toContainText('Last reply');
  await expect(frame.locator('#last-reply')).not.toContainText('43.8');
  await expect(frame.locator('#rate')).toHaveCount(0);
});

test('a freshness deadline clears recent speed from the screen and copied statistics', async ({ page }) => {
  await page.clock.install();
  await page.goto('/v2?surface=page&state=splash-decode');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#rate')).toHaveText('43.8');
  await page.evaluate(() => { (window as any).previewHold = true; });
  await page.clock.runFor(8_000);
  await expect(frame.locator('[data-stage="generation"] .speed-value > span')).toHaveCount(0);
  await expect(frame.locator('#view-live > .connection-diagnosis')).toContainText('No fresh readings');
  await frame.locator('#monitor-menu > summary').click();
  await frame.getByRole('button', { name: 'Share', exact: true }).click();
  await frame.getByRole('menuitem', { name: 'Copy stats', exact: true }).click();
  await expect(frame.locator('#action-status')).toContainText('Stats copied');
  const copied = await page.evaluate(() => (window as any).previewCopied as string);
  expect(copied).toContain('refreshing — held observations');
  expect(copied).not.toContain('Recent generation speed');
  expect(copied).toContain('Splash average generation speed since model start (all requests): 47.2 tok/s');
});

test('a short pause starts a fresh displayed window while lifetime details remain available', async ({ page }) => {
  await page.clock.install();
  await page.goto('/v2?surface=page&state=splash-decode');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#rate')).toHaveText('43.8');
  await frame.getByRole('button', { name: 'Pause monitoring', exact: true }).click();
  await expect(frame.locator('#phase')).toHaveText('Paused');
  const requests = await page.evaluate(() => (window as any).previewRequests);
  await page.clock.runFor(500);
  expect(await page.evaluate(() => (window as any).previewRequests)).toBe(requests);
  await frame.getByRole('button', { name: 'Resume monitoring', exact: true }).click();
  await expect(frame.locator('#hero')).toContainText('Measuring…');
  await expect(frame.locator('[data-stage="generation"] .speed-value > span')).toHaveCount(0);
  await expect(frame.locator('#rate')).toHaveCount(0);
  await page.clock.runFor(2_500);
  await expect(frame.locator('[data-stage="generation"] .speed-value > span')).toHaveCount(0);
  await frame.getByRole('button', { name: 'Server & Mac details', exact: true }).click();
  await expect(frame.locator('#panel-server')).toContainText('Overall average');
  await expect(frame.locator('#panel-server')).toContainText('47.2 tok/s');
  await frame.getByRole('button', { name: 'Back to Live', exact: true }).click();
  await page.clock.runFor(2_500);
  await expect(frame.locator('#rate')).toHaveText('43.8');
  await expect(frame.locator('[data-stage="generation"] .speed-source')).toContainText('last 4.0 s');
});

for (const theme of ['light', 'dark']) test(`recent engine labels and intervals fit Live, Compact and Session in ${theme}`, async ({ page }, testInfo) => {
  const evidence = process.env.SCOPE_EVIDENCE_DIR;
  for (const width of [320, 430, 1160]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/v2?surface=${width === 1160 ? 'page' : 'panel'}&state=splash-decode&theme=${theme}`);
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('#rate')).toHaveText('43.8');
    await expect(frame.locator('[data-stage="generation"]')).toContainText('Generation');
    const panelFrame = page.frames().find(frame => frame !== page.mainFrame())!;
    expect(await panelFrame.evaluate(inspect, false)).toEqual([]);
    if (evidence && testInfo.project.name === 'chromium') {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, `mlx-scope-splash-live-${theme}-${width}.png`) });
    }
    await frame.getByRole('button', { name: 'Server & Mac details', exact: true }).click();
    await expect(frame.locator('#panel-server')).toContainText('Recent speeds');
    await expect(frame.locator('#panel-server')).toContainText('All server activity · last 4.0 s');
    await expect(frame.locator('#panel-server')).toContainText('Overall average');
    await expect(frame.locator('#panel-server')).toContainText('47.2 tok/s');
    await frame.getByRole('button', { name: 'Back to Live', exact: true }).click();
    if (width === 430) {
      await frame.locator('#monitor-menu > summary').click();
      await frame.locator('#compact').click();
      await expect(frame.locator('#compact-glance .ws')).toContainText('Generating');
      await expect(frame.locator('#compact-glance .ws')).toContainText('last 4.0 s');
      expect(await panelFrame.evaluate(inspect, false)).toEqual([]);
    }
  }
  await page.goto(`/v2?surface=status&state=splash-decode&theme=${theme}`);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.ws-phase')).toHaveText('Generating');
  await expect(frame.locator('.ws-measurement .ws-label')).toHaveText('Engine');
  const panelFrame = page.frames().find(frame => frame !== page.mainFrame())!;
  const backdrop = await page.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
  expect(await panelFrame.evaluate(inspect, { openAll: false, backdrop })).toEqual([]);
  if (evidence && testInfo.project.name === 'chromium') await page.locator('iframe').screenshot({ path: join(evidence, `mlx-scope-splash-session-${theme}.png`) });
});

test('the Session pane shows live derived tok/s and follows theme changes', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 700, height: 500 });
  await page.goto('/v2?demo=1&surface=status&state=splash-decode&theme=graphite-mint');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.ws-reading')).toContainText('tok/s');
  await expect(frame.locator('.ws-measurement .ws-label')).toHaveText('Engine');
  await expect(frame.locator('.ws-phase')).toHaveText('Generating');
  await expect(frame.locator('.ws-measurement')).toHaveAttribute('title', /Calculated/);
  const rate = await frame.locator('.ws-reading').innerText();
  await expect.poll(() => frame.locator('.ws-reading').innerText()).not.toBe(rate);
  const evidence = process.env.SCOPE_EVIDENCE_DIR;
  if (evidence && testInfo.project.name === 'chromium') {
    await mkdir(evidence, { recursive: true });
    await page.locator('.preview-session').screenshot({ path: join(evidence, 'mlx-scope-splash-session.png') });
  }
  await page.getByRole('combobox', { name: 'Preview theme' }).selectOption('warm-amber');
  await expect(frame.locator('html')).toHaveAttribute('data-oc-theme', 'light');
  await expect(frame.locator('.ws-reading')).toContainText('tok/s');
  await page.evaluate(() => (window as any).setPreviewState('splash-measuring'));
  await expect(frame.locator('.ws-reading')).toHaveCount(0);
  await expect(frame.locator('#ws')).not.toContainText('tok/s');
});
