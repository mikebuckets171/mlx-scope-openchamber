import { expect, test } from '@playwright/test';

// playwright.config.ts exports the preview port to the workers.
const origin = `http://scope.test:${process.env.SCOPE_PREVIEW_PORT ?? 8787}`;

test('the panel runs on a plain HTTP host without secure-context APIs, and its preferences persist', async ({ page }) => {
  // Serve the local fixture under an ordinary HTTP origin, without changing DNS.
  await page.route(`${origin}/**`, async route => {
    const local = new URL(route.request().url()); local.hostname = '127.0.0.1';
    await route.fulfill({ response: await page.request.get(local.toString()) });
  });
  await page.goto(`${origin}/?state=prefill&transport=relay`);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#prefill-percent')).toHaveText('64%');
  expect(await frame.locator('body').evaluate(() => ({
    secure: isSecureContext, uuid: typeof crypto.randomUUID, random: typeof crypto.getRandomValues, subtle: typeof crypto.subtle,
  }))).toEqual({ secure: false, uuid: 'undefined', random: 'function', subtle: 'undefined' });
  // Each poll names its frame with 8 hex characters from getRandomValues.
  const [query] = await page.evaluate(() => (window as unknown as { previewQueries: Array<{ frame: string }> }).previewQueries);
  expect(query!.frame).toMatch(/^[0-9a-f]{8}$/);
  await frame.locator('#monitor-menu > summary').click();
  await frame.locator('#efficiency').click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('view.efficient'))).toBe('true');
  await page.reload();
  await expect(frame.locator('#prefill-percent')).toHaveText('64%');
  await expect(frame.locator('#efficiency')).toHaveAttribute('aria-pressed', 'true');
});
