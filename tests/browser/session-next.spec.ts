import { expect, test, type Page } from '@playwright/test';

// This host accepts header controls (?sdk=next), so Watch and Pause are drawn in its own section header and the
// in-widget toolbar is hidden; ?headers=fail keeps the toolbar as the fallback.
const header = (page: Page) => page.locator('#fixture-status-controls');
const watch = (page: Page, value: 'chat' | 'engine') => header(page).getByRole('combobox', { name: 'Watch', exact: true }).selectOption(value);
const pause = (page: Page, label: 'Pause' | 'Resume') => header(page).getByRole('button', { name: label, exact: true }).click();

const load = async (page: Page, query = '') => {
  const params = new URLSearchParams('sdk=next&surface=status&design=next&state=decode');
  for (const [key, value] of new URLSearchParams(query)) params.set(key, value);
  await page.goto(`/v2?${params}`);
  await page.locator('iframe[title="MLX Scope"]').evaluate(el => { (el as HTMLElement).style.width = '100%'; });
  const frame = page.frameLocator('iframe[title="MLX Scope"]');
  await expect(frame.locator('.ws-next')).toBeVisible();
  return frame;
};

for (const theme of ['dark', 'light']) for (const width of [300, 320, 430]) {
  test(`Session instrument and full-view action fit ${width}px in ${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    await page.setViewportSize({ width, height: 700 });
    const frame = await load(page, `theme=${theme}`);
    await expect(page).toHaveTitle(/MLX Scope/);
    await watch(page, 'engine');
    await expect(frame.locator('.ws-phase')).toHaveText('Generating');
    await expect(frame.locator('.ws-reading')).toContainText('tokens/s');
    await expect(frame.locator('.ws-label')).toHaveText('Engine');
    await expect(frame.locator('.ws-measurement')).toHaveAttribute('title', /average for this request/);
    // Phase and one reading: no in-section trace, support row or toolbar while the host header holds the controls.
    await expect(frame.locator('#ws-toolbar')).toBeHidden();
    expect(await frame.locator('#ws-toolbar').evaluate(el => el.getBoundingClientRect().height)).toBe(0);
    await expect(frame.locator('#ws-signal, .ws-plot, .ws-support, .ws-held')).toHaveCount(0);
    await expect(frame.locator('#ws-notice')).toBeHidden();
    expect(await frame.locator('#scope').evaluate(el => ({
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      height: el.getBoundingClientRect().height,
    }))).toEqual({ horizontalOverflow: false, height: expect.any(Number) });
    const open = frame.getByRole('button', { name: 'Open MLX Scope', exact: true });
    await expect(open).toBeInViewport({ ratio: 1 });
    await open.click();
    await expect.poll(() => page.evaluate('window.previewOpenedSurfaces')).toEqual(['plugin:mlx-scope']);
    expect(await page.evaluate('window.previewNextCalls')).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('Session keeps Open visible and focus stable at enlarged text with media and across freshness changes', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const frame = await load(page, 'media=eta');
  await watch(page, 'engine');
  await frame.locator('html').evaluate(el => { (el as HTMLElement).style.fontSize = '24px'; });
  const open = frame.getByRole('button', { name: 'Open MLX Scope', exact: true });
  await expect(frame.locator('.media-glance')).toBeVisible();
  await expect(open).toBeInViewport({ ratio: 1 });
  await open.focus();
  await page.evaluate('window.setPreviewState("offline")');
  await expect(frame.locator('.ws-phase')).toHaveText('Offline');
  await expect(frame.locator('.ws-measurement')).toBeHidden();
  await expect(frame.locator('#ws-notice .ws-notice')).toHaveCount(1);
  await expect(open).toBeFocused();
  await expect(open).toBeInViewport({ ratio: 1 });
  await page.evaluate('window.setPreviewState("decode")');
  await expect(frame.locator('.ws-phase')).toHaveText('Generating');
  await expect(open).toBeFocused();
  await frame.locator('#ws-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(open).toBeInViewport({ ratio: 1 });
  expect(await frame.locator('#scope').evaluate(el => el.scrollHeight)).toBeLessThanOrEqual(320);
  expect(await frame.locator('html').evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await frame.locator('html').evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
});

test('Session toolbar retains scope, pause and snapshot details when the host rejects header controls', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const frame = await load(page, 'headers=fail');
  await expect(frame.locator('.ws-toolbar')).toBeVisible();
  await frame.getByRole('combobox', { name: 'What to watch', exact: true }).selectOption('engine');
  await expect(frame.locator('.ws-label')).toContainText('Engine');
  const pause = frame.getByRole('button', { name: 'Pause', exact: true });
  await pause.click();
  await expect(frame.locator('.ws-phase')).toHaveText('Paused');
  await expect(frame.getByRole('button', { name: 'Resume', exact: true })).toBeFocused();
  await frame.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(frame.locator('.ws-phase')).toHaveText('Generating');
  await frame.getByRole('button', { name: 'Details', exact: true }).click();
  const card = page.frameLocator('iframe[title="Scope detail popover"]');
  await expect(card.getByRole('region', { name: 'Measurement details' })).toBeVisible();
  await expect(card.locator('body')).toContainText('Snapshot taken when opened');
  expect(await page.evaluate('window.previewPopoverCollectorCalls')).toEqual([]);
  expect(await page.evaluate('window.previewNextCalls')).toEqual([]);
});

test('Session uses one priority warning as its exception row and clears its reading when paused', async ({ page }) => {
  const frame = await load(page, 'state=pressure');
  await watch(page, 'engine');
  await expect(frame.locator('.ws-warning')).toHaveCount(1);
  await expect(frame.locator('.ws-warning')).toBeVisible();
  await expect(frame.locator('#ws-notice.ws-exceptions > p.ws-notice')).toHaveCount(1);
  await expect(frame.locator('#ws-notice > p.ws-notice')).toHaveAttribute('data-exception', 'alert');
  await expect(frame.locator('#ws-notice > p.ws-notice')).toHaveText('Memory pressure · warning');
  await expect(frame.locator('.ws-support')).toHaveCount(0);
  await pause(page, 'Pause');
  await expect(frame.locator('.ws-phase')).toHaveText('Paused');
  await expect(frame.locator('.ws-measurement')).toBeHidden();
  await expect(frame.locator('#ws-notice')).toBeHidden();
  await expect(frame.getByRole('button', { name: 'Open MLX Scope', exact: true })).toBeInViewport({ ratio: 1 });
});


test('a focused reading hands focus to Open when unavailable and opens snapshot details by keyboard', async ({ page }) => {
  const frame = await load(page);
  await watch(page, 'engine');
  const reading = frame.locator('.ws-measurement');
  await reading.focus();
  await expect(reading).toBeFocused();
  await page.evaluate('window.setPreviewState("offline")');
  await expect(frame.locator('.ws-phase')).toHaveText('Offline');
  await expect(frame.getByRole('button', { name: 'Open MLX Scope', exact: true })).toBeFocused();
  await page.evaluate('window.setPreviewState("decode")');
  await expect(frame.locator('.ws-phase')).toHaveText('Generating');
  await reading.focus();
  await reading.press('Enter');
  await expect(page.frameLocator('iframe[title="Scope detail popover"]').getByRole('region', { name: 'Measurement details' })).toBeVisible();
  expect(await page.evaluate('window.previewPopoverCollectorCalls')).toEqual([]);
});

for (const width of [300, 430]) test(`prompt ETA fits ${width}px and disappears after reading or pause`, async ({ page }) => {
  await page.setViewportSize({ width, height: 700 });
  const frame = await load(page, 'state=prefill');
  await expect(frame.locator('.prompt-eta')).toHaveText('Est. 20 s left');
  await expect(frame.locator('.ws-label')).toHaveText('EngineEst. 20 s left');
  await expect(frame.locator('.ws-measurement')).toHaveAttribute('title', /^Prompt read/);
  await expect(frame.locator('.prompt-eta')).toBeInViewport({ ratio: 1 });
  expect(await frame.locator('html').evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await pause(page, 'Pause');
  await expect(frame.locator('.prompt-eta')).toHaveCount(0);
  await page.evaluate('window.setPreviewState("decode")');
  await pause(page, 'Resume');
  await expect(frame.locator('.ws-phase')).toHaveText('Generating');
  await expect(frame.locator('.prompt-eta')).toHaveCount(0);
  await page.evaluate('window.setPreviewState("prefill")');
  await expect(frame.locator('.prompt-eta')).toBeVisible();
  await frame.getByRole('button', { name: /^Measurement details: / }).click();
  await expect(page.frameLocator('iframe[title="Scope detail popover"]').locator('body')).toContainText('Generation time is not included');
});

test('prompt ETA uses existing fresh progress when the engine omits an estimate', async ({ page }) => {
  await page.setViewportSize({ width: 300, height: 700 });
  const frame = await load(page, 'state=prefill');
  let previousAt = 0;
  const update = async (done: number, stale = false) => {
    // Simulate a source that advances once per second; repeated frame polls must not add samples.
    await expect.poll(() => Date.now() - previousAt).toBeGreaterThanOrEqual(1_100);
    previousAt = Date.now();
    await page.evaluate(({ done, stale }) => {
      const w = window as any, body = w.ScopeStates.mockBody('prefill', { now: Date.now() });
      delete body.capabilities['request.prefillEta']; delete body.runtime.request.prefillEtaMs;
      Object.assign(body.runtime.request, { prefillProcessedTokens: done, prefillTotalTokens: 10_000,
        prefillFraction: done / 10_000, prefillStale: stale, prefillObservedAt: Date.now() });
      w.setPreviewPatch({ runtime: body.runtime, capabilities: body.capabilities });
    }, { done, stale });
    await expect(frame.locator('#prefill-percent')).toHaveText(`${Math.floor(done / 100)}%`);
  };
  // Counts roll back from the initial fixture: a new observation window starts.
  await update(4_000); await expect(frame.locator('.prompt-eta')).toHaveCount(0);
  await update(4_200); await update(4_400);
  await expect(frame.locator('.prompt-eta')).toHaveText(/^Est\. .* left$/);
  await update(4_500, true); await expect(frame.locator('.prompt-eta')).toHaveCount(0);
  expect(await page.evaluate('window.previewUnexpectedSends')).toBe(0);
});

test('full Live shows the same qualified prompt ETA', async ({ page }) => {
  await page.goto('/v2?sdk=next&surface=page&state=prefill');
  const frame = page.frameLocator('iframe[title="MLX Scope"]');
  await expect(frame.locator('.instrument-source .prompt-eta')).toHaveText('Est. 20 s left');
});
