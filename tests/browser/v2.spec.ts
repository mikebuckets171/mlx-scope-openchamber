import { expect, test, type Page } from '@playwright/test';

// The panel reads /v2/snapshot, polls only while its frame can be seen, and names a stale service (contract §2, S11).
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
  await expect(frame.locator('#phase')).toHaveText('Generating');
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

test('a still-running 1.6 service or another contract version asks for a restart, not a runtime failure', async ({ page }) => {
  for (const contract of ['1.6', '3']) {
    await page.goto(`/?contract=${contract}`);
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('#restart-card h2')).toHaveText('MLX Scope needs a restart');
    await expect(frame.locator('#restart-card')).toContainText('The panel was updated, but its local service is still the old version.');
    await expect(frame.locator('#phase')).toHaveText('Needs restart');
    await expect(frame.locator('#machine')).toHaveCount(0);
    await expect(frame.locator('main')).not.toContainText(/NaN|undefined/);
  }
});

test('the synthetic host honours the since cursor: completions the frame has are not sent again', async ({ page }) => {
  await page.addInitScript(() => { if (window === window.top) (window as unknown as { previewAutoProvider: string }).previewAutoProvider = 'bionic'; });
  await page.goto('/?connections=1&bionic=idle');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#reply-strip')).toContainText('38.6');
  await expect.poll(async () => (await queries(page)).filter(query => query.since === '1').length).toBeGreaterThan(1);
  const bodies = await page.evaluate(() => (window as unknown as { previewBodies: Array<{ since?: string; items: number }> }).previewBodies);
  expect(bodies.filter(body => body.since === '1').every(body => body.items === 0)).toBe(true);
  // The reply stays on screen from the frame's own copy.
  await expect(frame.locator('#reply-strip')).toContainText('38.6');
});
