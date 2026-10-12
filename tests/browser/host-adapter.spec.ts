import { expect, test } from '@playwright/test';

for (const surface of ['page', 'status']) {
  test(`hidden ${surface} ignores injected host session and ready replays without DOM work`, async ({ page }) => {
    await page.goto(`/v2?surface=${surface}&state=idle&chat=local&frame=hidden`);
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('#scope')).toBeAttached();
    if (surface === 'page') await expect(frame.locator('#scope')).not.toHaveAttribute('hidden');
    await frame.locator('#scope').evaluate(root => {
      const state = window as unknown as { hostMutations: number };
      state.hostMutations = 0;
      new MutationObserver(records => { state.hostMutations += records.length; }).observe(root, { subtree: true, attributes: true, childList: true, characterData: true });
    });
    await page.evaluate(() => {
      const host = window as any;
      for (const busy of [true, false, true]) {
        host.setPreviewSession({ id: 'hidden-fixture-chat', busy, model: 'omlx/Example-27B-4bit' });
        host.sendPreviewLifecycle(busy ? 'started' : 'completed');
      }
    });
    await page.waitForTimeout(250);
    expect(await frame.locator('#scope').evaluate(() => (window as unknown as { hostMutations: number }).hostMutations)).toBe(0);
    expect(await page.evaluate(() => (window as any).previewRequests)).toBe(0);
    await page.locator('iframe').evaluate(el => { el.style.display = ''; });
    await expect(frame.locator('#scope')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).previewRequests)).toBeGreaterThan(0);
  });
}
