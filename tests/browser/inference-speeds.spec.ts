import { expect, test } from '@playwright/test';
import { inspect } from './ui-checks.ts';

for (const theme of ['light', 'dark']) test(`Session gives both stages native rows and fits narrow host widths in ${theme}`, async ({ page }) => {
  for (const width of [280, 284, 320]) {
    await page.setViewportSize({ width: width + 30, height: 450 });
    await page.goto(`/v2?surface=status&state=splash-mixed&theme=${theme}`);
    await page.locator('iframe').evaluate((el, w) => { (el as HTMLElement).style.width = `${w}px`; }, width);
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('[data-stage="prefill"] .speed-value')).toHaveText('612tok/s');
    await expect(frame.locator('[data-stage="generation"] .speed-value')).toHaveText('43.8tok/s');
    await expect(frame.locator('[data-stage="prefill"] dd')).toHaveAttribute('title', 'Calculated · last 3.2 s');
    await expect(frame.locator('[data-stage="generation"] dd')).toHaveAttribute('title', 'Calculated · last 4.0 s');
    await expect(frame.locator('#ws')).not.toContainText('47.2');
    const metrics = await frame.locator('.speed-rows:not(.progress-row)').evaluate(el => Array.from(el.querySelectorAll('.speed-value strong')).map(value => {
      const style = getComputedStyle(value); return { size: style.fontSize, weight: style.fontWeight };
    }));
    expect(metrics[0]).toEqual(metrics[1]); expect(metrics[0]?.size).toBe('13px');
    const child = page.frames().find(frame => frame !== page.mainFrame())!;
    const backdrop = await page.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
    expect(await child.evaluate(inspect, { openAll: false, backdrop })).toEqual([]);
    await page.evaluate(() => (window as any).setPreviewState('splash-prefill-waiting'));
    await expect(frame.locator('.ws-phase')).toHaveText('Reading prompt');
    await expect(frame.locator('[data-stage="prefill"] .speed-value')).toHaveText('Measuring…');
    await expect(frame.locator('[data-stage="generation"] .speed-value')).toHaveText('—');
    await expect(frame.locator('#ws')).not.toContainText('fresh output');
    await page.evaluate(() => (window as any).setPreviewState('splash-long-warning'));
    await expect(frame.locator('.ws-alert-row')).toContainText('Swap grew');
    await expect(frame.locator('.ws-model')).toHaveAttribute('title', /A-very-long-model-name/);
    expect(await child.evaluate(inspect, { openAll: false, backdrop })).toEqual([]);
    await frame.getByRole('button', { name: 'Open MLX Scope', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).previewOpenedSurfaces)).toEqual(['plugin:mlx-scope']);
  }
});

test('Energy saving gives an actionable missing-rate explanation and preserves a valid prefill reading', async ({ page }) => {
  await page.addInitScript(() => { if (window === window.top) sessionStorage.setItem('view.efficient', 'true'); });
  await page.goto('/v2?surface=status&state=splash-prefill-waiting&theme=light');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('[data-stage="prefill"]')).toContainText('Energy saving is on');
  await expect(frame.locator('.ws-note')).toHaveText('Turn off Energy saving to see speeds');
  await page.evaluate(() => (window as any).setPreviewState('splash-prefill'));
  await expect(frame.locator('[data-stage="prefill"] .speed-value')).toHaveText('612tok/s', { timeout: 8_000 });
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

test('extreme speeds fit 280px and retain full values; keyboard focus stays inside its target', async ({ page }, testInfo) => {
  await page.goto('/v2?surface=status&state=splash-extreme&theme=light');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('[data-stage="prefill"] .speed-value')).toHaveText('9.1Btok/s');
  await expect(frame.locator('[data-stage="generation"] .speed-value')).toHaveText('2.3Mtok/s');
  await expect(frame.locator('[data-stage="prefill"] .speed-value')).toHaveAttribute('aria-label', '9,100,000,000 tokens per second');
  expect(await frame.locator('[data-stage="prefill"]').ariaSnapshot()).toContain('9,100,000,000 tokens per second');
  const child = page.frames().find(frame => frame !== page.mainFrame())!;
  const backdrop = await page.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
  expect(await child.evaluate(inspect, { openAll: false, backdrop })).toEqual([]);
  await frame.locator('body').evaluate(el => { el.tabIndex = -1; el.focus(); }); await page.keyboard.press(testInfo.project.name === 'webkit' ? 'Alt+Tab' : 'Tab');
  const action = frame.getByRole('button', { name: 'Open MLX Scope', exact: true });
  await expect(action).toBeFocused();
  const focus = await action.evaluate(el => { const s = getComputedStyle(el); return { style: s.outlineStyle, offset: s.outlineOffset, width: s.outlineWidth }; });
  expect(focus).toEqual({ style: 'solid', offset: '-2px', width: '2px' });
});


test('oMLX progress stays separate from speed and clears on stale input', async ({ page }) => {
  await page.goto('/v2?surface=status&state=prefill&theme=light');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('[data-stage="progress"] dd')).toContainText('64%');
  await expect(frame.locator('[data-stage="prefill"] dt')).toHaveText('Prefill speed');
  await expect(frame.locator('[data-stage="prefill"] .speed-value')).toHaveText('185tok/s');
  await page.evaluate(() => (window as any).setPreviewState('splash-prefill'));
  await expect(frame.locator('[data-stage="progress"] dd')).toContainText('Unavailable');
  await expect(frame.locator('[data-stage="prefill"] .speed-value')).toHaveText('612tok/s');
  await page.evaluate(() => (window as any).setPreviewState('splash-stale'));
  await expect(frame.locator('.ws-phase')).toHaveText('Waiting for update');
  await expect(frame.locator('#ws')).not.toContainText('Status stale');
});

test('reported Splash progress and missing progress have honest separate rows in both themes', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.goto(`/v2?surface=status&state=splash-progress&theme=${theme}`);
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('[data-stage="progress"] dt')).toHaveText('Prompt progress');
    await expect(frame.locator('[data-stage="progress"] dd')).toContainText('64%');
    await expect(frame.locator('[data-stage="progress"] dd')).toHaveAttribute('title', /3840 of 6000 tokens/);
    await expect(frame.locator('[data-stage="prefill"] .speed-value')).toHaveText('612tok/s');
    await page.evaluate(() => (window as any).setPreviewState('splash-progress-held'));
    await expect(frame.locator('[data-stage="progress"] dd')).toContainText('64% (last seen)');
    await page.evaluate(() => (window as any).setPreviewState('splash-prefill'));
    await expect(frame.locator('[data-stage="progress"] dd')).toContainText('Unavailable');
    await expect(frame.locator('[data-stage="prefill"] .speed-value')).toHaveText('612tok/s');
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
