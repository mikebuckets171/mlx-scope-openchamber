import { expect, test, type Page } from '@playwright/test';
import { openMeasurementDetails } from './standard-ui.ts';

test.use({ timezoneId: 'UTC', locale: 'en-US' });

// The panel finishes its first storage reads after the page opens, and a slower machine can still be doing
// that when a test looks. Wait for quiet first, so these tests only see the work caused by what they do next.
async function settleStorage(page: Page): Promise<void> {
  let previous = -1;
  for (let attempt = 0; attempt < 40; attempt++) {
    const count = await page.evaluate(() => ((window as any).previewStorageOps ?? []).length);
    if (count === previous) return;
    previous = count;
    await page.waitForTimeout(250);
  }
}

for (const theme of ['light', 'dark']) for (const width of [320, 1160]) test(`recorded run detail and comparison preserve context at ${width}px in ${theme}`, async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/history.html?state=decode&theme=${theme}${width > 900 ? '&surface=page' : ''}`);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  const insights = page.locator('.history-insights'); await insights.locator('summary').click();
  const buttons = page.locator('.ledger [data-action="inspect"]');
  await expect(buttons).toHaveCount(6);
  await buttons.first().focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Recorded turn' })).toBeFocused();
  await expect(page.locator('.run-detail')).toContainText('not exact tool execution time');
  await expect(page.locator('.ledger')).not.toBeVisible();
  await page.keyboard.press('Escape');
  await expect(buttons.first()).toBeFocused(); await expect(insights).toHaveJSProperty('open', true);
  await buttons.nth(1).click();
  await expect(page.getByRole('heading', { name: 'Recorded reply' })).toBeFocused();
  await expect(page.locator('.run-detail')).toContainText('Last observed engine result');
  await expect(page.locator('.run-detail dt').filter({ hasText: /^First token$/ })).toHaveCount(0);
  const select = page.getByLabel('Compare with');
  await expect(select).toBeVisible();
  const value = await select.locator('option').nth(1).getAttribute('value');
  await select.selectOption(value!); await select.focus();
  await expect(page.locator('.run-comparison')).toContainText('Generation speed');
  await expect(page.locator('.run-detail')).toContainText('Two recorded replies');
  const before = await page.evaluate(() => { const h = (window as any).harness; return [h.trendReads.length, h.usageReads.length, h.cleared, h.retention.length, h.paused.length]; });
  await page.evaluate(() => (window as any).harness.decode(1000, 320));
  await expect(select).toBeFocused(); await expect(select).toHaveValue(value!);
  expect(await page.evaluate(() => { const h = (window as any).harness; return [h.trendReads.length, h.usageReads.length, h.cleared, h.retention.length, h.paused.length]; })).toEqual(before);
  if (width === 320) await page.locator('html').evaluate(el => { el.style.fontSize = '32px'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await test.info().attach('run-details', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  expect(errors).toEqual([]);
});

test('Now opens the shared current inspector without starting history collection and Back restores focus', async ({ page }) => {
  await page.goto('/v2?surface=page&state=decode&chat=local');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#rate')).toHaveText('26.4');
  await settleStorage(page);
  const reads = await page.evaluate(() => ({ storage: [...((window as any).previewStorageOps ?? [])],
    history: ((window as any).previewServicePaths ?? []).filter((path: string) => /trend|usage/.test(path)) }));
  await openMeasurementDetails(frame);
  await frame.getByRole('button', { name: 'Run details', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'Current observation' })).toBeFocused();
  await expect(frame.locator('#history-title')).toHaveText('Run details');
  await expect(frame.locator('.run-detail')).toContainText('26.4');
  await expect(frame.locator('.run-detail')).toContainText('Engine · Output');
  expect(await page.evaluate(() => (window as any).previewUnexpectedSends)).toBe(0);
  expect(await page.evaluate(() => ({ storage: (window as any).previewStorageOps ?? [],
    history: ((window as any).previewServicePaths ?? []).filter((path: string) => /trend|usage/.test(path)) }))).toEqual(reads);
  await frame.locator('#panel-history').getByRole('button', { name: 'Captures', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'Captures', exact: true })).toBeFocused();
  await frame.getByRole('button', { name: 'Back to Run details', exact: true }).click();
  await expect(frame.locator('#history-title')).toBeFocused();
  await expect(frame.getByRole('heading', { name: 'Current observation' })).toBeVisible();
  await frame.locator('#panel-history').getByRole('button', { name: 'Back', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Run details', exact: true })).toBeFocused();
  await expect(frame.locator('#rate')).toHaveText('26.4');
});

test('current inspection reuses History without refreshing expired reads and restores focus', async ({ page }) => {
  const now = Date.UTC(2026, 9, 3, 1, 0);
  await page.clock.setFixedTime(now);
  await page.goto('/v2?demo=1&surface=page&state=decode&chat=local&leader=0');
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'History', exact: true }).click();
  await expect(frame.locator('.ledger li').first()).toBeVisible();
  await frame.locator('#panel-history').getByRole('button', { name: 'Back', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'History', exact: true })).toBeFocused();
  // Make every view read due; a reused view must switch modes before update/activation.
  await page.clock.setFixedTime(now + 301_000);
  await settleStorage(page);
  const reads = await page.evaluate(() => ({ storage: [...((window as any).previewStorageOps ?? [])],
    history: ((window as any).previewServicePaths ?? []).filter((path: string) => /trend|usage/.test(path)) }));
  await openMeasurementDetails(frame);
  await frame.getByRole('button', { name: 'Run details', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'Current observation' })).toBeFocused();
  expect(await page.evaluate(() => ({ storage: (window as any).previewStorageOps ?? [],
    history: ((window as any).previewServicePaths ?? []).filter((path: string) => /trend|usage/.test(path)) }))).toEqual(reads);
  await frame.locator('#panel-history').getByRole('button', { name: 'Back', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Run details', exact: true })).toBeFocused();
});
