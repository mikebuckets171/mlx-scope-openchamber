import { expect, test } from '@playwright/test';
import { inspect } from './ui-checks.ts';

for (const theme of ['light', 'dark']) test(`Session shows the relevant stage and fits narrow host widths in ${theme}`, async ({ page }) => {
  for (const width of [260, 280, 320]) {
    await page.setViewportSize({ width: width + 30, height: 450 });
    await page.goto(`/v2?surface=status&state=splash-mixed&theme=${theme}`);
    await page.locator('iframe').evaluate((el, w) => { (el as HTMLElement).style.width = `${w}px`; }, width);
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('.ws-reading')).toHaveText('43.8 tok/s');
    await expect(frame.locator('.ws-measurement')).toHaveAttribute('title', /Calculated · last 4.0 s/);
    await expect(frame.locator('.ws-measurement .ws-label')).toHaveText('Engine');
    await expect(frame.locator('#ws')).not.toContainText('47.2');
    await expect(frame.locator('.speed-row')).toHaveCount(0);
    for (const fontSize of [24, 32]) {
      await frame.locator('html').evaluate((el, size) => { el.style.fontSize = `${size}px`; }, fontSize);
      await expect.poll(() => frame.locator('#ws').evaluate(el => {
        const reading = el.querySelector('.ws-measurement')!.getBoundingClientRect();
        return ['.ws-phase', '.scope-choice'].every(selector => el.querySelector(selector)!.getBoundingClientRect().bottom <= reading.top);
      })).toBe(true);
      await expect.poll(() => frame.locator('#ws').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight + 1)).toBe(true);
      expect(await frame.locator('#ws').evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await frame.locator('html').evaluate(el => { el.style.fontSize = '16px'; });
    const child = page.frames().find(frame => frame !== page.mainFrame())!;
    const backdrop = await page.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
    expect(await child.evaluate(inspect, { openAll: false, backdrop })).toEqual([]);
    await page.evaluate(() => (window as any).setPreviewState('splash-prefill-waiting'));
    await expect(frame.locator('.ws-phase')).toHaveText('Reading prompt');
    await expect(frame.locator('.ws-measurement')).toHaveCount(0);
    await expect(frame.locator('#ws')).not.toContainText('fresh output');
    await page.evaluate(() => (window as any).setPreviewState('splash-long-warning'));
    await expect(frame.locator('.ws-warning')).toContainText('Swap grew');
    await expect(frame.locator('.ws-model')).toHaveCount(0);
    expect(await child.evaluate(inspect, { openAll: false, backdrop })).toEqual([]);
    await frame.getByRole('button', { name: 'Open MLX Scope', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).previewOpenedSurfaces)).toEqual(['plugin:mlx-scope']);
    await frame.locator('html').evaluate(el => { el.style.fontSize = '24px'; });
    await expect.poll(() => frame.locator('#ws').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight + 1)).toBe(true);
    expect(await frame.locator('#ws').evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect.poll(() => frame.locator('#ws').evaluate(el => {
      const reading = el.querySelector('.ws-measurement')!.getBoundingClientRect();
      return ['.ws-phase', '.scope-choice'].every(selector => el.querySelector(selector)!.getBoundingClientRect().bottom <= reading.top);
    })).toBe(true);
    await expect(frame.getByRole('combobox', { name: 'Measurement scope' })).toBeVisible();
  }
});

test('Energy saving explains absent rates without hiding a valid prefill reading', async ({ page }) => {
  await page.addInitScript(() => { if (window === window.top) sessionStorage.setItem('view.efficient', 'true'); });
  await page.goto('/v2?surface=status&state=splash-prefill-waiting&theme=light');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.ws-note')).toHaveText('Energy saving is on');
  await expect(frame.locator('.ws-measurement')).toHaveCount(0);
  await page.evaluate(() => (window as any).setPreviewState('splash-prefill'));
  await expect(frame.locator('.ws-reading')).toHaveText('612 tok/s', { timeout: 8_000 });
  await expect(frame.locator('.ws-note')).toHaveCount(0);
});

test('pause and stale readings clear both current lanes without promoting averages', async ({ page }) => {
  await page.clock.install();
  await page.goto('/v2?surface=page&state=splash-mixed');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('[data-stage="prefill"] .speed-value')).toContainText('612');
  await frame.getByRole('button', { name: 'Pause monitoring', exact: true }).click();
  await expect(frame.locator('.speed-pair')).not.toContainText('tok/s');
  await expect(frame.locator('.speed-averages')).toContainText('Overall average');
  await frame.getByRole('button', { name: 'Resume monitoring', exact: true }).click();
  await page.clock.runFor(2_000);
  await expect(frame.locator('.speed-pair')).not.toContainText('tok/s');
  await page.clock.runFor(2_000);
  await expect(frame.locator('[data-stage="prefill"] .speed-value')).toContainText('612');
  await expect(frame.locator('[data-stage="generation"] .speed-value')).toContainText('43.8');
  await page.evaluate(() => { (window as any).previewHold = true; });
  await page.clock.runFor(8_000);
  await expect(frame.locator('.speed-pair')).not.toContainText('tok/s');
});

test('extreme rates fit and retain their full accessible value; keyboard focus stays inside its target', async ({ page }, testInfo) => {
  await page.goto('/v2?surface=status&state=splash-extreme&theme=light');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.ws-reading')).toHaveText('2.3M tok/s');
  await expect(frame.locator('.ws-reading')).toHaveAttribute('aria-label', '2,340,000 tokens per second');
  expect(await frame.locator('.ws-measurement').ariaSnapshot()).toContain('2,340,000 tokens per second');
  const child = page.frames().find(frame => frame !== page.mainFrame())!;
  const backdrop = await page.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
  expect(await child.evaluate(inspect, { openAll: false, backdrop })).toEqual([]);
  await frame.locator('body').evaluate(el => { el.tabIndex = -1; el.focus(); }); await page.keyboard.press(testInfo.project.name === 'webkit' ? 'Alt+Tab' : 'Tab');
  await expect(frame.getByLabel('Measurement scope')).toBeFocused();
  const scopeFocus = await frame.getByLabel('Measurement scope').evaluate(el => { const s = getComputedStyle(el); return { style: s.outlineStyle, offset: s.outlineOffset, width: s.outlineWidth }; });
  expect(scopeFocus).toEqual({ style: 'solid', offset: '-2px', width: '2px' });
  await page.keyboard.press(testInfo.project.name === 'webkit' ? 'Alt+Tab' : 'Tab');
  const action = frame.getByRole('button', { name: 'Open MLX Scope', exact: true });
  await expect(action).toBeFocused();
  const focus = await action.evaluate(el => { const s = getComputedStyle(el); return { style: s.outlineStyle, offset: s.outlineOffset, width: s.outlineWidth }; });
  expect(focus).toEqual({ style: 'solid', offset: '-2px', width: '2px' });
});

test('oMLX progress takes precedence while reading and stale input clears the measurement', async ({ page }) => {
  await page.goto('/v2?surface=status&state=prefill&theme=light');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.ws-reading')).toHaveText('64%');
  await expect(frame.locator('.ws-measurement .ws-label')).toContainText('prompt');
  await expect(frame.locator('#ws')).not.toContainText('185');
  await page.evaluate(() => (window as any).setPreviewState('splash-prefill'));
  await expect(frame.locator('.ws-reading')).toHaveText('612 tok/s');
  await expect(frame.locator('#ws')).not.toContainText('Unavailable');
  await page.evaluate(() => (window as any).setPreviewState('splash-stale'));
  await expect(frame.locator('.ws-phase')).toHaveText('Waiting for update');
  await expect(frame.locator('.ws-measurement')).toHaveCount(0);
  await expect(frame.locator('#ws')).not.toContainText('Status stale');
});

test('Splash progress uses reported counts, labels held observations, and never invents missing percentages', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.goto(`/v2?surface=status&state=splash-progress&theme=${theme}`);
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('.ws-reading')).toHaveText('64%');
    await expect(frame.locator('.ws-measurement')).toHaveAttribute('title', /3840 of 6000 tokens/);
    await expect(frame.locator('#ws')).not.toContainText('612');
    await page.evaluate(() => (window as any).setPreviewState('splash-progress-held'));
    await expect(frame.locator('.ws-reading')).toHaveText('64%');
    await expect(frame.locator('.ws-label')).toContainText('last seen');
    await expect(frame.locator('.ws-measurement')).toHaveAttribute('data-live', 'false');
    await page.evaluate(() => (window as any).setPreviewState('splash-prefill'));
    await expect(frame.locator('.ws-reading')).toHaveText('612 tok/s');
    await expect(frame.locator('#ws')).not.toContainText('Unavailable');
  }
});

test('full prompt progress stays visible and never rounds unfinished work to100%', async ({ page }) => {
  await page.goto('/v2?surface=page&state=prefill-near-complete');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#prefill-percent')).toBeVisible();
  await expect(frame.locator('#prefill-percent')).toHaveText('>99%');
  await expect(frame.locator('#prefill-progress [role="progressbar"]')).toHaveAttribute('aria-valuenow', '99.99');
  await expect(frame.locator('#request-details')).not.toHaveAttribute('open', '');
});

test('resume cannot restore older cached Splash progress from a fresh status response', async ({ page }) => {
  await page.clock.install();
  await page.goto('/v2?surface=page&state=splash-progress');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#prefill-percent')).toHaveText('64%');
  await page.evaluate(() => {
    const w = window as any, body = w.ScopeStates.mockBody('splash-progress', { now: Date.now() });
    w.cachedProgress = body.runtime;
    w.setPreviewPatch({ runtime: w.cachedProgress });
  });
  await frame.getByRole('button', { name: 'Pause monitoring', exact: true }).click();
  await expect(frame.locator('#prefill-percent')).toHaveCount(0);
  await page.clock.runFor(500);
  await frame.getByRole('button', { name: 'Resume monitoring', exact: true }).click();
  await page.clock.runFor(5_000);
  await expect(frame.locator('#prefill-percent')).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    w.cachedProgress.request.prefillObservedAt = Date.now();
    w.cachedProgress.sampledAt = Date.now();
  });
  await page.clock.runFor(2_000);
  await expect(frame.locator('#prefill-percent')).toHaveText('64%');
});
