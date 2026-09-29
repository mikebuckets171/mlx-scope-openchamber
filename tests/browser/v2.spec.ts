import { expect, test, type Page } from '@playwright/test';

// Stage 2a: the panel reads /v2/snapshot, polls only while its frame can be seen, and names a stale service.
const requests = (page: Page) => page.evaluate(() => (window as unknown as { previewRequests: number }).previewRequests);
const queries = (page: Page) => page.evaluate(() => (window as unknown as { previewQueries: Record<string, string>[] }).previewQueries);

test('a display:none frame makes zero service requests until it is shown, and stops again when hidden', async ({ page }) => {
  await page.goto('/?frame=hidden');
  const frame = page.frameLocator('iframe');
  // The panel mounts inside the hidden frame, as a rail tab that is not selected does (SPIKES S1).
  await expect(frame.locator('#startup-fallback')).toHaveCount(0);
  expect(await frame.locator('main').evaluate(() => document.hidden)).toBe(false);
  await page.waitForTimeout(1_500);
  expect(await requests(page)).toBe(0);
  await page.evaluate(() => (window as unknown as { setPreviewFrameHidden: (value: boolean) => void }).setPreviewFrameHidden(false));
  await expect.poll(() => requests(page)).toBeGreaterThan(0);
  await expect(frame.locator('#connection')).toHaveText('oMLX connected');
  await page.evaluate(() => (window as unknown as { setPreviewFrameHidden: (value: boolean) => void }).setPreviewFrameHidden(true));
  await page.waitForTimeout(400);
  const hidden = await requests(page);
  await page.waitForTimeout(1_500);
  expect(await requests(page)).toBe(hidden);
});

test('each poll asks for /v2/snapshot with this frame, its surface, the full tier and the completion cursor', async ({ page }) => {
  await page.goto('/?state=decode&surface=page');
  await expect.poll(async () => (await queries(page)).length).toBeGreaterThan(2);
  const [first, ...later] = await queries(page);
  expect(first).toEqual({ frame: expect.stringMatching(/^[0-9a-f]{8}$/), surface: 'page', tier: 'full' });
  for (const query of later) expect(query).toEqual({ frame: first!.frame, surface: 'page', tier: 'full', since: '0' });
});

test('a still-running 1.6 service or another contract version is named, not shown as a runtime failure', async ({ page }) => {
  for (const contract of ['1.6', '3']) {
    await page.goto(`/?contract=${contract}`);
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('#connection-message')).toHaveText(
      'MLX Scope was updated, but its local service is still the previous version. Pause and resume MLX Scope in Settings → Extensions.');
    await expect(frame.locator('#connection')).toHaveText('Waiting for Local runtime');
    await expect(frame.locator('#machine')).toBeHidden();
    await expect(frame.locator('main')).not.toContainText(/NaN|undefined/);
  }
});
