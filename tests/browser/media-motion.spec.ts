import { expect, test } from '@playwright/test';

for (const surface of ['status', 'panel', 'page']) test(`the ${surface} media ring centers a measured phase percentage without duplicate accessible values`, async ({ page }) => {
  await page.goto(`/v2?surface=${surface}&state=decode&chat=local&media=active`);
  const frame = page.frameLocator('iframe');
  if (surface === 'page') await frame.getByRole('tab', { name: 'Media', exact: true }).click();
  const ring = frame.locator('.media-ring:visible');
  await expect(ring).toHaveAttribute('aria-valuenow', '40');
  await expect(ring.locator('.media-ring-value')).toHaveText('40%');
  await expect(ring.locator('.media-ring-value')).toHaveAttribute('aria-hidden', 'true');
  await expect(ring).toHaveAttribute('aria-label', 'Sampling progress · this phase only');
  expect(await ring.locator('.media-ring-fill').evaluate(node => Number.parseFloat(getComputedStyle(node).strokeDashoffset))).toBe(60);
});

test('the ring eases same-phase measured updates and resets instantly when its phase or counter unit changes', async ({ page }) => {
  await page.clock.install(); await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/v2?surface=page&state=decode&chat=local&media=active');
  const frame = page.frameLocator('iframe');
  await frame.getByRole('tab', { name: 'Media', exact: true }).click();
  await expect(frame.locator('#view-media .media-ring-value')).toHaveText('40%');
  await frame.locator('#view-media .media-ring').evaluate(node => { (window as any).oldRing = node; });
  const update = async (value: number, phase = 'sampling', unit = 'steps', phaseKey?: string): Promise<void> => {
    await page.evaluate(({ value, phase, unit, phaseKey }) => { const w = window as any; const body = JSON.parse(w.ScopeMediaFixtures.respond({ payload: { path: '/v2/media' } }).body); body.jobs[0] = { ...body.jobs[0], phase, phaseKey, progress: { value, total: 20, unit, basis: 'phase' } }; w.previewMediaOverride = body; }, { value, phase, unit, phaseKey });
    await page.clock.runFor(1_100);
  };
  await update(11);
  await expect(frame.locator('#view-media .media-ring-value')).toHaveText('55%');
  expect(await frame.locator('#view-media .media-ring').evaluate(node => node === (window as any).oldRing)).toBe(true);
  expect(await frame.locator('#view-media .media-ring-fill').evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0.16s');
  await update(2, 'decoding', 'tiles');
  await expect(frame.locator('#view-media .media-ring-value')).toHaveText('10%');
  expect(await frame.locator('#view-media .media-ring').evaluate(node => node === (window as any).oldRing)).toBe(false);
  await frame.locator('#view-media .media-ring').evaluate(node => { (window as any).oldRing = node; });
  await update(1, 'decoding', 'tiles', 'a'.repeat(64));
  expect(await frame.locator('#view-media .media-ring').evaluate(node => node === (window as any).oldRing)).toBe(false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await frame.locator('#view-media .media-ring-fill').evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0s');
});

test('indeterminate work moves slowly only while visible and motion is allowed', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/v2?surface=page&state=decode&chat=local&media=basic');
  const frame = page.frameLocator('iframe');
  await frame.getByRole('tab', { name: 'Media', exact: true }).click();
  const arc = frame.locator('#view-media .media-ring-svg');
  await expect(frame.locator('#view-media .media-ring')).toHaveAttribute('data-mode', 'indeterminate');
  expect(await arc.evaluate(node => getComputedStyle(node).animationName)).toBe('media-orbit');
  expect(await arc.evaluate(node => getComputedStyle(node).animationDuration)).toBe('3.6s');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await arc.evaluate(node => getComputedStyle(node).animationName)).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await frame.getByRole('tab', { name: 'History', exact: true }).click();
  expect(await arc.evaluate(node => getComputedStyle(node).animationName)).toBe('none');
  await frame.getByRole('tab', { name: 'Media', exact: true }).click();
  await page.evaluate(() => (window as any).setPreviewFrameHidden(true));
  await expect(frame.locator('#scope')).toHaveAttribute('data-media-motion', 'false');
  expect(await arc.evaluate(node => getComputedStyle(node).animationName)).toBe('none');
});

for (const state of ['waiting', 'queued', 'stale', 'last-reported']) test(`${state} progress is static and never presented as live motion`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`/v2?surface=page&state=decode&chat=local&media=${state}`);
  const frame = page.frameLocator('iframe');
  await frame.getByRole('tab', { name: 'Media', exact: true }).click();
  const ring = frame.locator('#view-media .media-ring');
  await expect(ring).toHaveAttribute('data-mode', state === 'last-reported' ? 'stale' : 'static');
  expect(await ring.locator('svg').evaluate(node => getComputedStyle(node).animationName)).toBe('none');
  expect(await ring.locator('.media-ring-fill').evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0s');
  if (state === 'last-reported') {
    await expect(ring.locator('.media-ring-value')).toHaveText('40%');
    await expect(frame.locator('#view-media')).toContainText('Last reported · Sampling');
    await expect(frame.locator('#view-media')).toContainText('Waiting for update');
    await expect(ring).toHaveAttribute('aria-label', 'Sampling last reported progress · this phase only');
    await expect(frame.getByRole('button', { name: 'Cancel job', exact: true })).toHaveCount(0);
  } else await expect(ring).not.toHaveAttribute('aria-valuenow');
});
