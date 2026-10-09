import { expect, test, type Page } from '@playwright/test';

const auxiliary = (page: Page, path: string, method?: string) => page.evaluate(({ path, method }) => (window as any).previewAuxiliaryRequests.filter((request: any) => request.path === path && (!method || request.method === method)).length, { path, method });

test('Connections explains detected capabilities and only installs a media helper after Enable', async ({ page }) => {
  await page.goto('/v2?surface=page&state=decode&chat=local&media=active');
  const frame = page.frameLocator('iframe');
  await expect.poll(() => auxiliary(page, '/v2/media/setup')).toBe(1);
  expect(await auxiliary(page, '/v2/media/setup', 'POST')).toBe(0);
  await frame.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'Chat speed', exact: true })).toBeVisible();
  await expect(frame.getByRole('button', { name: 'Enable chat speed', exact: true })).toBeVisible();
  await frame.getByRole('button', { name: 'Enable detailed media progress', exact: true }).click();
  await expect(frame.locator('#media-setup')).toContainText('activates next time ComfyUI starts');
  expect(await auxiliary(page, '/v2/media/setup', 'POST')).toBe(1);
  await frame.getByRole('button', { name: 'Close connections' }).click();
  await expect(frame.locator('#connection-setup')).toBeHidden();
});

test('Media identifies ownership and phase-local progress, then confirms exact-job cancellation', async ({ page }) => {
  await page.goto('/v2?surface=page&state=decode&chat=local&media=active');
  const frame = page.frameLocator('iframe');
  await frame.getByRole('tab', { name: 'Media', exact: true }).click();
  await expect(frame.locator('.media-job')).toContainText('This chat');
  await expect(frame.getByRole('progressbar', { name: 'Sampling progress · this phase only' })).toHaveAttribute('aria-valuenow', '40');
  await expect(frame.locator('.media-job')).toContainText('8 / 20 steps');
  await frame.getByRole('button', { name: 'Cancel job', exact: true }).click();
  expect(await auxiliary(page, '/v2/media/cancel', 'POST')).toBe(0);
  await expect(frame.getByRole('button', { name: 'Keep running', exact: true })).toBeFocused();
  await frame.getByRole('button', { name: 'Cancel this job', exact: true }).click();
  await expect.poll(() => auxiliary(page, '/v2/media/cancel', 'POST')).toBe(1);
  await frame.locator('.media-recent > summary').click();
  await expect(frame.locator('.media-job')).toContainText('Cancelled');
  await expect(frame.getByRole('button', { name: 'Cancel job', exact: true })).toHaveCount(0);
});

for (const state of ['basic', 'waiting', 'stale']) test(`${state} media never invents a percentage or ETA`, async ({ page }) => {
  await page.goto(`/v2?surface=page&state=decode&chat=local&media=${state}`);
  const frame = page.frameLocator('iframe');
  await frame.getByRole('tab', { name: 'Media', exact: true }).click();
  const bar = frame.locator('.media-job [role="progressbar"]');
  await expect(bar).toBeVisible(); await expect(bar).not.toHaveAttribute('aria-valuenow');
  await expect(frame.locator('.media-job')).not.toContainText('%');
  await expect(frame.locator('.media-job')).not.toContainText('ETA');
  if (state === 'stale') await expect(frame.getByRole('button', { name: 'Cancel job', exact: true })).toHaveCount(0);
});

test('Session media remains within host height at enlarged text and narrow width', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 700 });
  await page.goto('/v2?surface=status&state=decode&chat=local&media=other');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.media-glance')).toContainText('Unassigned');
  await frame.locator('html').evaluate(element => { (element as HTMLElement).style.fontSize = '24px'; });
  await expect(frame.getByRole('button', { name: 'Open MLX Scope', exact: true })).toBeVisible();
  expect(await frame.locator('#scope').evaluate(element => ({ height: element.getBoundingClientRect().height, overflow: document.documentElement.scrollWidth > innerWidth }))).toEqual(expect.objectContaining({ overflow: false }));
  expect(await frame.locator('#scope').evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(320);
});

test('hidden surfaces stop both media reads and helper activation checks', async ({ page }) => {
  await page.clock.install();
  await page.goto('/v2?surface=page&state=decode&chat=local&media=active');
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Connections', exact: true }).click();
  await frame.getByRole('button', { name: 'Enable detailed media progress', exact: true }).click();
  await frame.locator('#scope').evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const before = await auxiliary(page, '/v2/media'), setups = await auxiliary(page, '/v2/media/setup');
  await page.clock.fastForward(31_000);
  expect(await auxiliary(page, '/v2/media')).toBe(before); expect(await auxiliary(page, '/v2/media/setup')).toBe(setups);
});

test('navigation keeps the Media tab keyboard-accessible and polling stops on History', async ({ page }) => {
  await page.clock.install();
  await page.goto('/v2?surface=page&state=decode&chat=local&media=active');
  const frame = page.frameLocator('iframe');
  await frame.getByRole('tab', { name: 'Live', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(frame.getByRole('tab', { name: 'Media', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(frame.getByRole('tab', { name: 'History', exact: true })).toBeFocused();
  const before = await auxiliary(page, '/v2/media'); await page.clock.fastForward(5_000);
  expect(await auxiliary(page, '/v2/media')).toBe(before);
});

test('fresh numeric readings roll only changed digits and stop for Reduce Motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/v2?surface=page&state=decode&chat=local');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#rate')).toHaveText('26.4');
  await frame.locator('#scope').evaluate(() => {
    const original = Element.prototype.animate;
    (window as any).scopeMotion = [];
    Element.prototype.animate = function (...args) {
      if (this.classList.contains('digit-current') || this.classList.contains('digit-before')) (window as any).scopeMotion.push({ value: this.textContent, options: args[1] });
      return original.apply(this, args);
    };
  });
  const update = async (rate: number): Promise<void> => {
    await page.evaluate(value => { const w = window as any, body = w.ScopeStates.mockBody('decode', { now: Date.now() }); body.runtime.request.decodeTps = value; w.setPreviewPatch({ runtime: body.runtime }); }, rate);
    await frame.locator('#monitor-menu > summary').click(); await frame.locator('#refresh').click();
  };
  await update(27.9);
  await expect(frame.locator('#rate')).toHaveText('27.9');
  const changes = await frame.locator('#scope').evaluate(() => (window as any).scopeMotion);
  expect(changes.map((change: any) => change.value).sort()).toEqual(['4', '6', '7', '9']);
  expect(changes.every((change: any) => change.options.duration === 160)).toBe(true);
  expect(await frame.locator('#rate').getAttribute('aria-hidden')).toBe('true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await update(28.2); await expect(frame.locator('#rate')).toHaveText('28.2');
  expect(await frame.locator('#scope').evaluate(() => (window as any).scopeMotion.length)).toBe(4);
  expect(await frame.locator('#scope').evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0);
});

test('pending helper activation refreshes only inside the open setup screen', async ({ page }) => {
  await page.clock.install();
  await page.goto('/v2?surface=page&state=decode&chat=local&media=active');
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Connections', exact: true }).click();
  await frame.getByRole('button', { name: 'Enable detailed media progress', exact: true }).click();
  await expect(frame.locator('#media-setup')).toContainText('activates next time');
  const before = await auxiliary(page, '/v2/media/setup');
  await page.clock.runFor(10_050);
  await expect.poll(() => auxiliary(page, '/v2/media/setup')).toBe(before + 1);
  await frame.getByRole('button', { name: 'Close connections' }).click();
  await page.clock.runFor(21_000);
  expect(await auxiliary(page, '/v2/media/setup')).toBe(before + 1);
});

test('turning off media stops its reads while LLM monitoring continues, and Enable reconnects', async ({ page }) => {
  await page.clock.install();
  await page.goto('/v2?surface=page&state=decode&chat=local&media=active');
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Connections', exact: true }).click();
  await frame.getByLabel('Monitor media', { exact: true }).uncheck();
  await expect(frame.getByLabel('Monitor media', { exact: true })).not.toBeChecked();
  await frame.getByRole('button', { name: 'Close connections' }).click();
  const before = await auxiliary(page, '/v2/media'), llm = await page.evaluate(() => (window as any).previewRequests);
  await page.clock.runFor(8_000);
  expect(await auxiliary(page, '/v2/media')).toBe(before);
  expect(await page.evaluate(() => (window as any).previewRequests)).toBeGreaterThan(llm);
  await expect(frame.locator('.media-glance')).toHaveCount(0);
  await frame.getByRole('button', { name: 'Connections', exact: true }).click();
  await frame.getByLabel('Monitor media', { exact: true }).check();
  await frame.getByRole('button', { name: 'Close connections' }).click();
  await expect(frame.locator('.media-glance')).toBeVisible();
});

for (const width of [260, 280, 320]) test(`combined Session and media remain usable at 200% text in ${width}px host`, async ({ page }) => {
  await page.setViewportSize({ width, height: 750 });
  await page.goto('/v2?surface=status&state=splash-long-warning&media=active');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.media-glance')).toBeVisible();
  await frame.locator('html').evaluate(element => { (element as HTMLElement).style.fontSize = '32px'; });
  expect(await frame.locator('html').evaluate(element => getComputedStyle(element).fontSize)).toBe('32px');
  await expect.poll(() => frame.locator('#scope').evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(320);
  expect(await frame.locator('#scope').evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  const action = frame.getByRole('button', { name: 'Open MLX Scope', exact: true });
  await action.focus();
  expect(await action.evaluate(element => { const r = element.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })).toBe(true);
  await frame.locator('.media-glance').scrollIntoViewIfNeeded();
  expect(await frame.locator('.media-glance').evaluate(element => { const r = element.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1; })).toBe(true);
  expect(await frame.locator('#scope').evaluate(element => { const style = getComputedStyle(element); return element.scrollHeight <= element.clientHeight || style.overflowY === 'auto'; })).toBe(true);
});
