import { expect, test } from '@playwright/test';

// 1.5: less-used controls live in the ⋯ menu; open it (if closed) before using one.
const openMenu = async (frame: import('@playwright/test').FrameLocator): Promise<void> => {
  if (!(await frame.locator('#monitor-menu').evaluate(element => (element as HTMLDetailsElement).open))) await frame.locator('#monitor-menu > summary').click();
};
// playwright.config.ts exports the preview port to the workers.
const origin = `http://scope.test:${process.env.SCOPE_PREVIEW_PORT ?? 8787}`;
const menu = async (frame: import('@playwright/test').FrameLocator, selector: string): Promise<void> => { await openMenu(frame); await frame.locator(selector).click(); };

test('Saved observations work on a plain HTTP host without secure-context UUID support', async ({ page }) => {
  // Serve the local fixture under an ordinary HTTP origin, without changing DNS.
  await page.route(`${origin}/**`, async route => {
    const local = new URL(route.request().url()); local.hostname = '127.0.0.1';
    await route.fulfill({ response: await page.request.get(local.toString()) });
  });
  await page.goto(`${origin}/?state=prefill&transport=relay`);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#connection')).toHaveText('oMLX connected');
  expect(await frame.locator('body').evaluate(() => ({
    secure: isSecureContext, uuid: typeof crypto.randomUUID, random: typeof crypto.getRandomValues,
  }))).toEqual({ secure: false, uuid: 'undefined', random: 'function' });

  await openMenu(frame); await frame.getByRole('button', { name: 'Save snapshot', exact: true }).click();
  await expect(frame.locator('#action-status')).toContainText('Observation saved');
  await openMenu(frame); await frame.getByRole('button', { name: 'Save snapshot', exact: true }).click();
  await frame.getByRole('tab', { name: 'Saved', exact: true }).click();
  await expect(frame.locator('#saved-count')).toHaveText('2 / 12');
  await expect(frame.locator('.saved-row')).toHaveCount(2);

  await page.reload();
  await expect(frame.locator('#connection')).toHaveText('oMLX connected');
  await frame.getByRole('tab', { name: 'Saved', exact: true }).click();
  await expect(frame.locator('.saved-row')).toHaveCount(2);
});
