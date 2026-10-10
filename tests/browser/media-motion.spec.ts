import { expect, test } from '@playwright/test';

// The ring rule: the ring never displays a number. The percentage is text beside it, so it can never clip the stroke.
for (const surface of ['status', 'panel', 'page']) test(`the ${surface} media ring holds no number; its measured phase percentage is text beside it`, async ({ page }) => {
  await page.goto(`/v2?surface=${surface}&state=decode&chat=local&media=active`);
  const frame = page.frameLocator('iframe');
  const ring = frame.locator('.media-ring:visible'), percent = frame.locator('.media-percent:visible');
  await expect(ring).toHaveAttribute('aria-valuenow', '40');
  await expect(ring).toHaveAttribute('aria-label', 'Sampling progress · this phase only');
  await expect(ring).toHaveAttribute('aria-valuetext', '40% · 8 / 20 steps · Sampling only');
  expect(await ring.evaluate(node => node.textContent?.trim())).toBe('');
  await expect(frame.locator('.media-ring-value')).toHaveCount(0);
  await expect(percent).toHaveText('40%');
  // The rail and page carry the column's Media block; the sidebar carries the glance.
  await expect(frame.locator(surface === 'status' ? '.media-glance-phase' : '#view-media .media-phase')).toContainText(surface === 'status' ? 'Video · 40% phase progress' : 'Sampling · 40%');
  // Beside, never inside: the text and the ring's box do not overlap.
  const [a, b] = [await ring.boundingBox(), await percent.boundingBox()];
  expect(a && b && (b.x >= a.x + a.width || b.x + b.width <= a.x || b.y >= a.y + a.height || b.y + b.height <= a.y)).toBe(true);
  expect(await ring.locator('.media-ring-fill').evaluate(node => Number.parseFloat(getComputedStyle(node).strokeDashoffset))).toBe(60);
});

test('the ring draws once on arrival, eases same-phase updates, and replaces itself without easing across phases', async ({ page }) => {
  await page.clock.install(); await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/v2?surface=page&state=decode&chat=local&media=active');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#view-media')).toBeVisible();
  await expect(frame.locator('#view-media .media-percent')).toHaveText('40%');
  const fill = frame.locator('#view-media .media-ring-fill');
  expect(await fill.evaluate(node => [getComputedStyle(node).animationName, getComputedStyle(node).animationDuration, getComputedStyle(node).animationIterationCount])).toEqual(['media-ring-draw', '0.2s', '1']);
  await expect.poll(() => fill.evaluate(node => node.getAnimations().length)).toBe(0); // the arrival draw has finished
  await frame.locator('#view-media').evaluate(node => {
    (window as any).draws = 0; (window as any).oldRing = node.querySelector('.media-ring');
    node.addEventListener('animationstart', event => { if ((event as AnimationEvent).animationName === 'media-ring-draw') (window as any).draws += 1; });
  });
  const update = async (value: number, phase = 'sampling', unit = 'steps', phaseKey?: string): Promise<void> => {
    await page.evaluate(({ value, phase, unit, phaseKey }) => { const w = window as any; const body = JSON.parse(w.ScopeMediaFixtures.respond({ payload: { path: '/v2/media' } }).body); body.jobs[0] = { ...body.jobs[0], phase, phaseKey, progress: { value, total: 20, unit, basis: 'phase' } }; w.previewMediaOverride = body; }, { value, phase, unit, phaseKey });
    await page.clock.runFor(1_100);
  };
  await update(11);
  await expect(frame.locator('#view-media .media-percent')).toHaveText('55%');
  expect(await frame.locator('#view-media .media-ring').evaluate(node => node === (window as any).oldRing)).toBe(true);
  expect(await fill.evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0.16s');
  expect(await fill.evaluate(node => node.getAttribute('style'))).toBe('stroke-dashoffset:45');
  await page.waitForTimeout(400);
  expect(await frame.locator('#view-media').evaluate(() => (window as any).draws)).toBe(0); // a received value eases; it never redraws
  await update(2, 'decoding', 'tiles');
  await expect(frame.locator('#view-media .media-percent')).toHaveText('10%');
  expect(await frame.locator('#view-media .media-ring').evaluate(node => node === (window as any).oldRing)).toBe(false);
  await expect.poll(() => frame.locator('#view-media').evaluate(() => (window as any).draws)).toBe(1); // a new phase is a new arrival
  await frame.locator('#view-media .media-ring').evaluate(node => { (window as any).oldRing = node; });
  await update(1, 'decoding', 'tiles', 'a'.repeat(64));
  expect(await frame.locator('#view-media .media-ring').evaluate(node => node === (window as any).oldRing)).toBe(false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await fill.evaluate(node => [getComputedStyle(node).transitionDuration, getComputedStyle(node).animationName])).toEqual(['0s', 'none']);
});

test('indeterminate work is still: an empty dotted track, with no ambient or looping animation anywhere', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/v2?surface=page&state=decode&chat=local&media=basic');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#view-media')).toBeVisible();
  const ring = frame.locator('#view-media .media-ring');
  await expect(ring).toHaveAttribute('data-mode', 'indeterminate');
  for (const part of ['.media-ring-svg', '.media-ring-fill']) expect(await ring.locator(part).evaluate(node => getComputedStyle(node).animationName)).toBe('none');
  expect(await ring.locator('.media-ring-fill').evaluate(node => Number.parseFloat(getComputedStyle(node).strokeDashoffset))).toBe(100);
  expect(await ring.locator('.media-ring-track').evaluate(node => getComputedStyle(node).strokeDasharray)).not.toBe('none');
  expect(await frame.locator('#scope').evaluate(() => document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations === Infinity).length)).toBe(0);
  await frame.getByRole('button', { name: 'History', exact: true }).click();
  await frame.getByRole('button', { name: 'Back', exact: true }).click();
  await page.evaluate(() => (window as any).setPreviewFrameHidden(true));
  await expect(frame.locator('#scope')).toHaveAttribute('data-media-motion', 'false');
  expect(await ring.locator('.media-ring-svg').evaluate(node => getComputedStyle(node).animationName)).toBe('none');
});

for (const state of ['waiting', 'queued', 'stale', 'last-reported']) test(`${state} progress is static and never presented as live motion`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`/v2?surface=page&state=decode&chat=local&media=${state}`);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#view-media')).toBeVisible();
  const ring = frame.locator('#view-media .media-ring');
  await expect(ring).toHaveAttribute('data-mode', state === 'last-reported' ? 'stale' : 'static');
  expect(await ring.locator('svg').evaluate(node => getComputedStyle(node).animationName)).toBe('none');
  expect(await ring.locator('.media-ring-fill').evaluate(node => [getComputedStyle(node).transitionDuration, getComputedStyle(node).animationName])).toEqual(['0s', 'none']);
  expect(await ring.evaluate(node => node.textContent?.trim())).toBe('');
  if (state === 'last-reported') {
    await expect(frame.locator('#view-media .media-percent')).toHaveText('40%');
    await expect(frame.locator('#view-media')).toContainText('Last reported · Sampling · 40%');
    await expect(frame.locator('#view-media')).toContainText('Waiting for update');
    await expect(ring).toHaveAttribute('aria-label', 'Sampling last reported progress · this phase only');
    await expect(frame.getByRole('button', { name: 'Cancel job', exact: true })).toHaveCount(0);
  } else await expect(ring).not.toHaveAttribute('aria-valuenow');
});

test('a confirmed cancellation drains the same ring over 120 ms; Reduce Motion drains instantly', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/v2?surface=page&state=decode&chat=local&media=active');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#view-media')).toBeVisible();
  const ring = frame.locator('#view-media .media-ring');
  await expect(ring).toHaveAttribute('data-mode', 'measured');
  await ring.evaluate(node => { (window as any).oldRing = node; });
  await frame.getByRole('button', { name: 'Cancel job', exact: true }).click();
  await page.evaluate(() => { (window as any).previewHold = true; }); // keep the request pending so the drain is observable
  await frame.getByRole('button', { name: 'Cancel this job', exact: true }).click();
  await expect(ring).toHaveAttribute('data-mode', 'draining');
  expect(await ring.evaluate(node => node === (window as any).oldRing)).toBe(true);
  expect(await ring.locator('.media-ring-fill').evaluate(node => [node.getAttribute('style'), getComputedStyle(node).transitionDuration])).toEqual(['stroke-dashoffset:100', '0.12s']);
  await expect.poll(() => ring.locator('.media-ring-fill').evaluate(node => Number.parseFloat(getComputedStyle(node).strokeDashoffset))).toBe(100);
  await expect(ring).not.toHaveAttribute('aria-valuenow');
  await expect(frame.locator('#view-media .media-percent')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await ring.locator('.media-ring-fill').evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0s');
});

test('a completed job holds a still, full, dimmed ring beside its measured finish', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/v2?surface=page&state=decode&chat=local&media=finished');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#view-media')).toBeVisible();
  await frame.locator('.media-recent > summary').click();
  const ring = frame.locator('#view-media .media-ring');
  await expect(ring).toHaveAttribute('data-mode', 'done');
  await expect(ring).toHaveAttribute('aria-hidden', 'true');
  await expect(frame.locator('#view-media [role="progressbar"]')).toHaveCount(0);
  const fill = ring.locator('.media-ring-fill');
  expect(await fill.evaluate(node => [Number.parseFloat(getComputedStyle(node).strokeDashoffset), getComputedStyle(node).animationName, getComputedStyle(node).transitionDuration])).toEqual([0, 'none', '0s']);
  expect(await ring.evaluate(node => getComputedStyle(node).color)).toBe(await frame.locator('#view-media .media-counters').evaluate(node => getComputedStyle(node).color));
  expect(await ring.evaluate(node => node.textContent?.trim())).toBe('');
});
