import { expect, test, type FrameLocator, type Page } from '@playwright/test';

// The 2.0 panel on the synthetic 1.x host (tests/browser/host.html, bodies converted by the real v1 → v2 bridge):
// startup and transport, visibility and pause, stalls, preferences, sharing, connection help and theme changes. The G2
// mock states themselves are in ui-core.spec.ts on the 2.0 fixture host.
type W = Window & Record<string, any>;
const openMenu = async (frame: FrameLocator): Promise<void> => {
  if (!(await frame.locator('#monitor-menu').evaluate(element => (element as HTMLDetailsElement).open))) await frame.locator('#monitor-menu > summary').click();
};
const menu = async (frame: FrameLocator, selector: string): Promise<void> => { await openMenu(frame); await frame.locator(selector).click(); };
const requests = (page: Page) => page.evaluate(() => (window as W).previewRequests as number);
const openPanel = async (page: Page, query = '') => {
  await page.goto(`/?${query}`);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#startup-fallback')).toHaveCount(0);
  await expect(frame.locator('#scope')).toBeVisible();
  await expect.poll(() => requests(page)).toBeGreaterThan(0);
  await expect(frame.locator('#phase')).not.toHaveText('Connecting');
  return frame;
};
const overflows = (frame: FrameLocator) => frame.locator('#scope').evaluate(() => document.documentElement.scrollWidth > innerWidth);
const errorsOf = (page: Page) => { const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); return errors; };

test('packaged entry gives a useful accessible state when its bundle cannot load', async ({ page }) => {
  await page.route('**/panel/main.js', route => route.abort());
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/panel/index.html');
  await expect(page.getByRole('heading', { name: 'MLX Scope' })).toBeVisible();
  await expect(page.locator('#startup-fallback [role="status"]')).toHaveText(
    'Starting MLX Scope. If this message remains visible, the extension interface could not start. Reload MLX Scope from OpenChamber’s Settings → Extensions.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('a synchronous bootstrap failure restores the accessible startup fallback', async ({ page }) => {
  await page.clock.install();
  await page.route('**/panel/main.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nthrow new Error('bootstrap fixture failure');` });
  });
  await page.goto('/panel/index.html');
  await expect(page.locator('#startup-fallback [role="status"]')).toHaveText('The extension interface could not start. Reload MLX Scope from OpenChamber’s Settings → Extensions.');
  await page.clock.fastForward(6_100);
  await expect(page.locator('#startup-fallback')).toBeVisible();
  await expect(page.locator('.scope')).toBeHidden();
});

test('an unopened host shows setup guidance rather than an endless loading claim', async ({ page }) => {
  await page.clock.install();
  await page.goto('/?nohost=1');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#startup-fallback')).toBeVisible();
  await page.clock.fastForward(6_100);
  await expect(frame.locator('#startup-fallback [role="status"]')).toContainText('Open this monitor from the extension panel in OpenChamber');
  expect(await requests(page)).toBe(0);
});

test('relay srcdoc transport renders packaged assets, follows theme changes and pauses polling', async ({ page }) => {
  const errors = errorsOf(page);
  await page.setViewportSize({ width: 1160, height: 950 });
  const frame = await openPanel(page, 'transport=relay&surface=page&state=prefill');
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  const document = await page.locator('iframe').getAttribute('srcdoc');
  expect(document).toContain('http-equiv="Content-Security-Policy"');
  expect(document).toMatch(/src="data:(?:application|text)\/javascript;base64,/);
  expect(await page.evaluate(() => (window as W).previewTransportError)).toBe('');
  await expect(frame.locator('#phase')).toHaveText('Reading prompt');
  await expect(frame.locator('#connection')).toHaveText('oMLX');
  await expect(frame.locator('#prefill-percent')).toHaveText('64%');
  await expect(frame.locator('#prefill-progress')).toContainText('5,824 of 9,100 new tokens read');
  await frame.getByRole('button', { name: 'Server & Mac details', exact: true }).click();
  await expect(frame.locator('[data-key="server-memory"]')).toContainText('15.9 GiB');
  await expect(frame.locator('html')).toHaveCSS('background-color', 'rgb(16, 21, 27)');
  await page.evaluate(() => (window as W).setPreviewTheme('light'));
  await expect(frame.locator('html')).toHaveCSS('background-color', 'rgb(247, 249, 251)');
  await frame.getByRole('tab', { name: 'Live', exact: true }).click();
  await frame.locator('#pause').click();
  await expect(frame.locator('#paused-note')).toHaveText('Nothing is read while paused, so no reply is recorded.');
  const before = await requests(page);
  await page.waitForTimeout(1_200);
  expect(await requests(page)).toBe(before);
  await frame.locator('#pause').click();
  await expect.poll(() => requests(page)).toBeGreaterThan(before);
  await expect(frame.locator('#prefill-percent')).toHaveText('64%');
  expect(errors).toEqual([]);
});

test('responsive layouts keep the masthead aligned and never overflow, in every host theme', async ({ page }) => {
  for (const theme of ['dark', 'light', 'violet', 'sand']) for (const width of [320, 430, 1160]) {
    await page.setViewportSize({ width, height: 1000 });
    const frame = await openPanel(page, `theme=${theme}&surface=${width >= 900 ? 'page' : 'panel'}&long=1`);
    await expect(frame.locator('#model')).toContainText('a-very-long-model-name');
    expect(await overflows(frame), `${theme}/${width}`).toBe(false);
    const alignment = await frame.locator('.masthead').evaluate(el => {
      const brand = el.querySelector('.brand')!.getBoundingClientRect(), controls = el.querySelector('.monitor-controls')!.getBoundingClientRect();
      return { centerDelta: Math.abs(brand.y + brand.height / 2 - controls.y - controls.height / 2), clear: brand.right <= controls.left };
    });
    expect(alignment.centerDelta, `${theme}/${width}: header alignment`).toBeLessThan(2);
    expect(alignment.clear, `${theme}/${width}: header controls overlap the name`).toBe(true);
    await frame.getByRole('button', { name: 'Server & Mac details', exact: true }).click();
    expect(await overflows(frame), `${theme}/${width} server`).toBe(false);
  }
});

test('runtime states and missing readings are explicit, never zero or placeholders', async ({ page }) => {
  for (const state of ['idle', 'prefill', 'queued', 'notLoaded', 'offline', 'auth', 'processing']) {
    const frame = await openPanel(page, `state=${state}`);
    await expect(frame.locator('#scope')).not.toContainText(/NaN|undefined|VRAM/);
    if (state === 'notLoaded') await expect(frame.locator('#phase')).toHaveText('No model loaded');
    if (state === 'auth') await expect(frame.locator('#panel-live .connection-diagnosis')).toContainText('refused Scope’s key');
    if (state === 'prefill') await expect(frame.locator('#prefill-progress [role="progressbar"]')).toHaveAttribute('aria-valuenow', '64');
    if (state === 'offline') {
      await expect(frame.locator('#panel-live .connection-diagnosis')).toContainText('stopped responding');
      await expect(frame.locator('#rate')).toHaveCount(0);
      await expect(frame.locator('.machine-summary')).toBeVisible();
      await frame.getByRole('button', { name: 'Server & Mac details', exact: true }).click();
      await expect(frame.locator('#machine')).toContainText('1.1 GiB');
    }
  }
  let frame = await openPanel(page, 'native=missing');
  await expect(frame.locator('.machine-summary')).not.toContainText('Swap');
  frame = await openPanel(page, 'system=linux');
  await expect(frame.locator('.machine-summary h2')).toHaveText('This computer');
  frame = await openPanel(page, 'system=missing');
  await expect(frame.locator('.machine-summary')).toHaveCount(0);
});

test('manual pause survives visibility changes and resumes once', async ({ page }) => {
  const frame = await openPanel(page);
  await frame.locator('#pause').click();
  await expect(frame.locator('#pause')).toHaveAttribute('aria-label', 'Resume monitoring');
  await expect(frame.locator('#phase')).toHaveText('Paused');
  const before = await requests(page);
  await page.waitForTimeout(1_200);
  expect(await requests(page)).toBe(before);
  await frame.locator('#scope').evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(600);
  expect(await requests(page)).toBe(before);
  await frame.locator('#pause').click();
  await expect.poll(() => requests(page)).toBeGreaterThan(before);
  await openMenu(frame);
  await expect(frame.locator('#refresh')).toBeEnabled();
});

test('hidden panels stop polling', async ({ page }) => {
  const frame = await openPanel(page);
  await frame.locator('#scope').evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const before = await requests(page);
  await page.waitForTimeout(1_200);
  expect(await requests(page)).toBe(before);
  await frame.locator('#scope').evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => requests(page)).toBeGreaterThan(before);
});

test('stalled responses cannot leave a live rate on screen', async ({ page }) => {
  const frame = await openPanel(page, 'state=stalled');
  await expect(frame.locator('#rate')).toBeVisible();
  await expect(frame.locator('#rate')).toHaveCount(0, { timeout: 9_000 });
  await expect(frame.locator('#view-live > .connection-diagnosis')).toContainText('No fresh readings');
});

test('returning to a hidden panel with a pending request never presents old speed as live', async ({ page }) => {
  const frame = await openPanel(page, 'state=prefill');
  await expect(frame.locator('#prefill-percent')).toHaveText('64%');
  await frame.locator('#scope').evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.evaluate(() => { (window as W).previewHold = true; });
  await frame.locator('#scope').evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(frame.locator('#prefill-progress')).toHaveCount(0);
  await expect(frame.locator('#phase')).toHaveText('Refreshing');
  await openMenu(frame); await frame.getByRole('button', { name: 'Share', exact: true }).click();
  await frame.getByRole('menuitem', { name: 'Copy stats', exact: true }).click();
  await expect(frame.locator('#action-status')).toContainText('Stats copied');
  expect(await page.evaluate(() => (window as W).previewCopied)).toContain('refreshing — held observations');
});

test('a restored browser view waits for fresh readings even without a visibility event', async ({ page }) => {
  const frame = await openPanel(page, 'state=prefill');
  await expect(frame.locator('#prefill-percent')).toHaveText('64%');
  await page.evaluate(() => { (window as W).previewHold = true; });
  await frame.locator('#scope').evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(frame.locator('#prefill-progress')).toHaveCount(0);
  await expect(frame.locator('#phase')).toHaveText('Refreshing');
});

test('session shortcuts never put a chat title on screen', async ({ page }) => {
  const frame = await openPanel(page, 'item=session&sessionTitle=Private%20chat&chat=1');
  await expect(frame.locator('#scope')).not.toContainText('Private chat');
  await expect(frame.locator('#scope')).not.toContainText('Local coding session');
});

test('energy saving reduces polling without pausing the model', async ({ page }) => {
  const frame = await openPanel(page);
  await menu(frame, '#efficiency');
  await expect(frame.locator('#efficiency')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(1_000);
  const before = await requests(page);
  await page.waitForTimeout(1_500);
  expect(await requests(page)).toBeLessThanOrEqual(before + 1);
  await expect(frame.locator('#pause')).toHaveAttribute('aria-pressed', 'false');
  await menu(frame, '#refresh');
  await expect.poll(() => requests(page)).toBeGreaterThan(before);
});

test('view choices survive reload with no repeated storage writes', async ({ page }) => {
  let frame = await openPanel(page, 'state=prefill');
  await menu(frame, '#compact'); await menu(frame, '#efficiency');
  await expect.poll(() => page.evaluate(() => (window as W).previewWrites)).toBe(2);
  await page.reload(); frame = page.frameLocator('iframe');
  await expect(frame.locator('#compact')).toHaveAttribute('aria-pressed', 'true');
  await expect(frame.locator('#efficiency')).toHaveAttribute('aria-pressed', 'true');
  await expect(frame.locator('#compact-glance')).toBeVisible();
  await page.waitForTimeout(1_000);
  expect(await page.evaluate(() => (window as W).previewWrites)).toBe(0);
});

test('storage failures never block monitoring or claim a saved preference', async ({ page }) => {
  const frame = await openPanel(page, 'storage=fail');
  await menu(frame, '#compact');
  await expect(frame.locator('#compact')).toHaveAttribute('aria-pressed', 'true');
  await expect(frame.locator('#action-status')).toContainText('could not save');
  const before = await requests(page);
  await expect.poll(() => requests(page)).toBeGreaterThan(before);
});

test('copy stats uses the host clipboard, carries no chat or model data, and reports failure honestly', async ({ page }) => {
  let frame = await openPanel(page, 'state=prefill&long=1&sessionTitle=PRIVATE');
  await frame.locator('#pause').click(); await openMenu(frame);
  await frame.getByRole('button', { name: 'Share', exact: true }).click(); await frame.getByRole('menuitem', { name: 'Copy stats', exact: true }).click();
  await expect(frame.locator('#action-status')).toContainText('Stats copied');
  const copied = await page.evaluate(() => (window as W).previewCopied);
  expect(copied).toContain('held observations');
  expect(copied).not.toMatch(/PRIVATE|publisher|request_id|api_key/);
  frame = await openPanel(page, 'clipboard=fail');
  await openMenu(frame); await frame.getByRole('button', { name: 'Share', exact: true }).click(); await frame.getByRole('menuitem', { name: 'Copy stats', exact: true }).click();
  await expect(frame.locator('#action-status')).toContainText('Could not copy');
});

test('Add to chat draft appends a sanitized report without sending, and needs an open chat', async ({ page }) => {
  let frame = await openPanel(page, 'chat=1&state=prefill');
  await openMenu(frame); await frame.getByRole('button', { name: 'Share', exact: true }).click();
  await frame.getByRole('menuitem', { name: 'Add to chat draft' }).click();
  await expect(frame.locator('#action-status')).toContainText('Nothing was sent automatically');
  expect(await page.evaluate(() => (window as W).previewDraft)).toMatch(/^Existing draft\n\nMLX Scope/);
  expect((await page.evaluate(() => (window as W).previewComposed)).text).not.toMatch(/Local coding session|Qwen/);
  expect(await page.evaluate(() => (window as W).previewUnexpectedSends)).toBe(0);
  await expect(frame.locator('#monitor-menu > summary')).toBeFocused();
  frame = await openPanel(page);
  await openMenu(frame); await frame.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(frame.getByRole('menuitem', { name: 'Add to chat draft' })).toBeDisabled();
});

test('the ⋯ menu stays opaque and readable with a translucent host elevation', async ({ page }) => {
  for (const theme of ['dark', 'light']) for (const width of [320, 430, 1160]) {
    await page.setViewportSize({ width, height: 800 });
    const frame = await openPanel(page, `theme=${theme}&translucent=1&surface=${width > 900 ? 'page' : 'panel'}`);
    await openMenu(frame);
    const values = await frame.locator('.monitor-menu-content').evaluate(element => {
      const style = getComputedStyle(element), box = element.getBoundingClientRect(), energy = element.querySelector('#efficiency')!.getBoundingClientRect();
      return { background: style.backgroundImage, menuWidth: box.width, energyWidth: energy.width, right: box.right };
    });
    expect(values.background, `${theme}/${width}: menu needs a backing layer`).toContain('linear-gradient');
    expect(values.energyWidth).toBeGreaterThan(values.menuWidth - 30);
    expect(values.right).toBeLessThanOrEqual(width);
  }
});

test('the toasts preference cycles critical → all → off and is kept in pref.v2', async ({ page }) => {
  const frame = await openPanel(page);
  await expect(frame.locator('#toasts-state')).toHaveText('critical only');
  await menu(frame, '#toasts');
  await expect(frame.locator('#toasts-state')).toHaveText('all alerts');
  await menu(frame, '#toasts');
  await expect(frame.locator('#toasts-state')).toHaveText('off');
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('pref.v2') ?? '{}').toasts)).toBe('off');
});

test('connection help uses the supported status call only on demand', async ({ page }) => {
  for (const status of ['ready', 'starting', 'stopped', 'failed']) {
    const frame = await openPanel(page, `state=offline&service=${status}`);
    expect(await page.evaluate(() => (window as W).previewStatusChecks)).toBe(0);
    await frame.locator('#pause').click();
    const before = await requests(page);
    await frame.locator('#panel-live .connection-diagnosis').getByRole('button', { name: 'Connection…' }).click();
    await expect(frame.locator('#connection-setup')).toBeVisible();
    await frame.locator('#connection-help summary').click();
    await frame.locator('#check-connection').click();
    const expected = { ready: 'If readings are missing', starting: 'starting', stopped: 'stopped', failed: 'could not start' }[status]!;
    await expect(frame.locator('#connection-result')).toContainText(expected);
    expect(await page.evaluate(() => (window as W).previewStatusChecks)).toBe(1);
    expect(await requests(page)).toBe(before);
  }
});

test('a denied service check never shows raw errors; the guide link is the documented one', async ({ page }) => {
  const frame = await openPanel(page, 'denied=1&state=offline');
  await menu(frame, '#connection-change');
  await frame.locator('#connection-help summary').click();
  await frame.locator('#check-connection').click();
  await expect(frame.locator('#connection-result')).toContainText('Allow MLX Scope');
  await expect(frame.locator('#scope')).not.toContainText('fixture detail');
  await frame.locator('#connection-guide').click();
  await expect.poll(() => page.evaluate(() => (window as W).previewOpenedURL)).toMatch(/^https:\/\/github.com\/mikebuckets171\/mlx-scope-openchamber\/blob\/v[\d.]+\/docs\/CONFIGURATION.md$/);
});

test('live host theme changes update the view in place without restarting monitoring', async ({ page }) => {
  const frame = await openPanel(page, 'state=decode');
  const pause = await frame.locator('#pause').elementHandle();
  const before = await requests(page);
  await page.evaluate(() => { for (let i = 0; i < 20; i++) (window as W).setPreviewTheme(i % 2 ? 'light' : 'dark'); });
  await page.waitForTimeout(1_050);
  expect(await pause!.evaluate(el => el.isConnected)).toBe(true);
  expect((await requests(page)) - before).toBeLessThanOrEqual(4);
  for (const theme of ['violet', 'sand']) {
    await page.evaluate(value => (window as W).setPreviewTheme(value), theme);
    const expected = await page.evaluate(() => (window as W).previewTheme);
    await expect.poll(() => frame.locator('.scope').evaluate(el => getComputedStyle(el).getPropertyValue('--oc-primary-text').trim())).toBe(expected.tokens.primaryText);
  }
});

test('concurrent requests withhold per-request speed, and hostile model names render as text', async ({ page }) => {
  const frame = await openPanel(page, 'multi=1');
  await expect(frame.locator('#hero')).toContainText('2 requests');
  await expect(frame.locator('.speed-pair')).not.toContainText('tok/s');
  await expect(frame.locator('#attribution')).toContainText('All server activity · several requests at once');
  await frame.getByRole('button', { name: 'Server & Mac details', exact: true }).click();
  await expect(frame.locator('[data-key="server-residency"] .resident-row')).toHaveCount(2);
  await page.evaluate(() => (window as W).setPreviewOverride({ residentModels: [{ id: '<img src=x onerror=alert(1)>', phase: 'idle', activeRequests: 0 }] }));
  await menu(frame, '#refresh');
  await expect(frame.locator('[data-key="server-residency"]')).toContainText('<img');
  await expect(frame.locator('[data-key="server-residency"] img')).toHaveCount(0);
});

test('DFlash output without a reported rate reads as working, never an invented average or prefill percentage', async ({ page }) => {
  const frame = await openPanel(page, 'state=dflash-preparing');
  await expect(frame.locator('#phase')).toHaveText('Working');
  await expect(frame.locator('#prefill-progress')).toHaveCount(0);
  await expect(frame.locator('#rate')).toHaveCount(0);
  await expect(frame.locator('[data-stage="generation"]')).toContainText('Waiting for samples');
  await page.evaluate(() => (window as W).setPreviewState('dflash'));
  await expect(frame.locator('#phase')).toHaveText('Generating');
  await expect(frame.locator('#rate')).toHaveCount(0);
  await expect(frame.locator('[data-stage="generation"]')).toContainText('Waiting for samples');
  await expect(frame.locator('#hero')).toContainText('doesn’t report this request’s speed');
});
