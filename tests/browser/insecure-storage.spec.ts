import { expect, test } from '@playwright/test';

test('Saved observations work on a plain HTTP host without secure-context UUID support', async ({ page }) => {
  // Serve the local fixture under an ordinary HTTP origin, without changing DNS.
  await page.route('http://scope.test:8787/**', async route => {
    const local = new URL(route.request().url()); local.hostname = '127.0.0.1';
    await route.fulfill({ response: await page.request.get(local.toString()) });
  });
  await page.goto('http://scope.test:8787/?state=prefill&transport=relay');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#connection')).toHaveText('oMLX connected');
  expect(await frame.locator('body').evaluate(() => ({
    secure: isSecureContext, uuid: typeof crypto.randomUUID, random: typeof crypto.getRandomValues,
  }))).toEqual({ secure: false, uuid: 'undefined', random: 'function' });

  await frame.getByRole('button', { name: 'Save snapshot', exact: true }).click();
  await expect(frame.locator('#action-status')).toContainText('Observation saved');
  await frame.getByRole('button', { name: 'Save snapshot', exact: true }).click();
  await frame.getByRole('tab', { name: 'Saved', exact: true }).click();
  await expect(frame.locator('#saved-count')).toHaveText('2 / 12');
  await expect(frame.locator('.saved-row')).toHaveCount(2);

  await page.reload();
  await expect(frame.locator('#connection')).toHaveText('oMLX connected');
  await frame.getByRole('tab', { name: 'Saved', exact: true }).click();
  await expect(frame.locator('.saved-row')).toHaveCount(2);
});
