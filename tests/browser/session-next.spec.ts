import { expect, test, type Page } from '@playwright/test';

const load = async (page: Page, query = '') => {
  const params = new URLSearchParams('sdk=next&surface=status&design=next&state=decode');
  for (const [key, value] of new URLSearchParams(query)) params.set(key, value);
  await page.goto(`/v2?${params}`);
  await page.locator('iframe[title="MLX Scope"]').evaluate(el => { (el as HTMLElement).style.width = '100%'; });
  const frame = page.frameLocator('iframe[title="MLX Scope"]');
  await expect(frame.locator('.ws-next')).toBeVisible();
  return frame;
};

for (const theme of ['dark', 'light']) for (const width of [320, 430]) {
  test(`Session instrument and full-view action fit ${width}px in ${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    await page.setViewportSize({ width, height: 700 });
    const frame = await load(page, `theme=${theme}`);
    await expect(page).toHaveTitle(/MLX Scope/);
    await page.getByRole('combobox', { name: 'Watch', exact: true }).selectOption('engine');
    await expect(frame.locator('.ws-phase')).toHaveText('Generating');
    await expect(frame.locator('.ws-reading')).toContainText('tokens/s');
    await expect(frame.locator('.ws-label')).toContainText('Engine · request average');
    await expect(frame.locator('#ws-signal svg')).toBeVisible();
    expect(await frame.locator('#scope').evaluate(el => ({
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      height: el.getBoundingClientRect().height,
    }))).toEqual({ horizontalOverflow: false, height: expect.any(Number) });
    const open = frame.getByRole('button', { name: 'Open MLX Scope', exact: true });
    await expect(open).toBeInViewport({ ratio: 1 });
    await open.click();
    await expect.poll(() => page.evaluate('window.previewOpenedSurfaces')).toEqual(['plugin:mlx-scope']);
    expect(await page.evaluate('window.previewNextCalls')).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('Session keeps Open visible and focus stable at enlarged text with media and across freshness changes', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const frame = await load(page, 'media=eta');
  await page.getByRole('combobox', { name: 'Watch', exact: true }).selectOption('engine');
  await frame.locator('html').evaluate(el => { (el as HTMLElement).style.fontSize = '24px'; });
  const open = frame.getByRole('button', { name: 'Open MLX Scope', exact: true });
  await expect(frame.locator('.media-glance')).toBeVisible();
  await expect(open).toBeInViewport({ ratio: 1 });
  await open.focus();
  await page.evaluate('window.setPreviewState("offline")');
  await expect(frame.locator('.ws-phase')).toHaveText('Offline');
  await expect(frame.locator('.ws-measurement')).toBeHidden();
  await expect(frame.locator('#ws-signal')).toBeHidden();
  await expect(open).toBeFocused();
  await expect(open).toBeInViewport({ ratio: 1 });
  await page.evaluate('window.setPreviewState("decode")');
  await expect(frame.locator('.ws-phase')).toHaveText('Generating');
  await expect(open).toBeFocused();
  await frame.locator('#ws-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(open).toBeInViewport({ ratio: 1 });
  expect(await frame.locator('#scope').evaluate(el => el.scrollHeight)).toBeLessThanOrEqual(320);
  expect(await frame.locator('html').evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await frame.locator('html').evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
});

test('Session fallback includes Watch, Pause and snapshot Details when the host rejects header controls', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const frame = await load(page, 'headers=fail');
  await expect(frame.locator('.ws-toolbar')).toBeVisible();
  await frame.getByRole('combobox', { name: 'Measurement scope', exact: true }).selectOption('engine');
  await expect(frame.locator('.ws-label')).toContainText('Engine');
  const pause = frame.getByRole('button', { name: 'Pause', exact: true });
  await pause.click();
  await expect(frame.locator('.ws-phase')).toHaveText('Paused');
  await expect(frame.getByRole('button', { name: 'Resume', exact: true })).toBeFocused();
  await frame.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(frame.locator('.ws-phase')).toHaveText('Generating');
  await frame.getByRole('button', { name: 'Details', exact: true }).click();
  const card = page.frameLocator('iframe[title="Scope detail popover"]');
  await expect(card.getByRole('region', { name: 'Measurement details' })).toBeVisible();
  await expect(card.locator('body')).toContainText('Snapshot taken when opened');
  expect(await page.evaluate('window.previewPopoverCollectorCalls')).toEqual([]);
  expect(await page.evaluate('window.previewNextCalls')).toEqual([]);
});

test('Session uses one priority warning and clears its trace when paused', async ({ page }) => {
  const frame = await load(page, 'state=pressure');
  await page.getByRole('combobox', { name: 'Watch', exact: true }).selectOption('engine');
  await expect(frame.locator('.ws-warning')).toHaveCount(1);
  await expect(frame.locator('.ws-warning')).toBeVisible();
  await expect(frame.locator('.ws-support')).toBeHidden();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(frame.locator('.ws-phase')).toHaveText('Paused');
  await expect(frame.locator('#ws-signal')).toBeHidden();
  await expect(frame.locator('.ws-measurement')).toBeHidden();
  await expect(frame.getByRole('button', { name: 'Open MLX Scope', exact: true })).toBeInViewport({ ratio: 1 });
});


test('a focused reading hands focus to Open when unavailable and opens snapshot details by keyboard', async ({ page }) => {
  const frame = await load(page);
  await page.getByRole('combobox', { name: 'Watch', exact: true }).selectOption('engine');
  const reading = frame.locator('.ws-measurement');
  await reading.focus();
  await expect(reading).toBeFocused();
  await page.evaluate('window.setPreviewState("offline")');
  await expect(frame.locator('.ws-phase')).toHaveText('Offline');
  await expect(frame.getByRole('button', { name: 'Open MLX Scope', exact: true })).toBeFocused();
  await page.evaluate('window.setPreviewState("decode")');
  await expect(frame.locator('.ws-phase')).toHaveText('Generating');
  await reading.focus();
  await reading.press('Enter');
  await expect(page.frameLocator('iframe[title="Scope detail popover"]').getByRole('region', { name: 'Measurement details' })).toBeVisible();
  expect(await page.evaluate('window.previewPopoverCollectorCalls')).toEqual([]);
});
