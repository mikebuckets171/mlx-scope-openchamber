import { expect, test } from '@playwright/test';

for (const surface of ['status', 'page']) test(`a busy hint preserves a fresh engine reading while refreshing ${surface}`, async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    if (window.parent === window) sessionStorage.setItem('pref.v2', JSON.stringify({ v: 2, history: false, measurementScope: 'engine' }));
  });
  await page.goto(`/v2?surface=${surface}&state=decode&chat=local`);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#rate')).toHaveText('26.4');
  await page.evaluate(() => {
    const w = window as any;
    w.previewDelay = true;
    w.setPreviewSession({ id: 'fixture-chat', title: 'Fixture chat', busy: false, model: 'omlx/Example-27B-4bit' });
  });
  await expect.poll(() => page.evaluate(() => (window as any).previewDeferred.length)).toBeGreaterThan(0);
  await expect(frame.locator('#rate')).toHaveText('26.4');
  await expect(frame.locator(surface === 'status' ? '.ws-phase' : '#phase')).toHaveText('Generating');
  // The ordinary expiry still clears a stalled refresh; an activity hint never extends freshness.
  await page.clock.fastForward(6_100);
  await expect(frame.locator('#rate')).toHaveCount(0);
  await expect(frame.locator(surface === 'status' ? '.ws-phase' : '.instrument-phase')).toHaveText('Waiting for update');
});
