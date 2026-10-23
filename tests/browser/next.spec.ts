import { expect, test, type Page } from '@playwright/test';
const state = <T>(page: Page, fn: string): Promise<T> => page.evaluate(fn) as Promise<T>;
const load = async (page: Page, query = '', path = '/') => {
  await page.setViewportSize({ width: 430, height: 900 });
  const params = new URLSearchParams('sdk=next&state=decode&chat=1');
  for (const [key, value] of new URLSearchParams(query)) params.set(key, value);
  await page.goto(`${path}?${params}`);
  const frame = page.frameLocator('iframe[title="MLX Scope"]');
  await expect(frame.locator('#scope')).toBeVisible();
  return frame;
};

for (const query of ['', 'design=classic', 'sdk=legacy']) test(`the polished instrument is standard with no design picker (${query || 'new device'})`, async ({ page }) => {
  const frame = await load(page, query);
  await expect(frame.locator('html')).toHaveAttribute('data-design-mode', 'next');
  await expect(frame.locator('#hero .precision-identity')).toBeVisible();
  await expect(frame.locator('#design-mode,[data-design-choice]')).toHaveCount(0);
  await frame.locator('#monitor-menu > summary').click();
  await expect(frame.locator('#monitor-menu')).not.toContainText('Classic');
  expect(await state(page, 'window.previewNextCalls')).toEqual([]);
  expect(await state(page, 'window.previewNextWrites')).toEqual([]);
  await page.reload();
  await expect(frame.locator('#scope')).toBeVisible();
  await expect(frame.locator('html')).toHaveAttribute('data-design-mode', 'next');
  expect(await state(page, 'window.previewForbiddenNextCalls')).toEqual([]);
});

test('device storage failure remains visible without undoing the current design', async ({ page }) => {
  const frame = await load(page, 'deviceStorage=fail');
  await expect(frame.locator('#scope-awareness')).toContainText('Could not load device preferences');
  await frame.locator('.awareness-settings > summary').click();
  await frame.getByLabel('Chats and subagents').check();
  await expect(frame.locator('html')).toHaveAttribute('data-design-mode', 'next');
  await expect(frame.locator('#scope-awareness')).toContainText('could not save device preferences');
});

for (const state of ['needs-approval', 'contract-mismatch']) test(`local History stays available while ${state} blocks live readings`, async ({ page }) => {
  const frame = await load(page, `surface=page&state=${state}`, '/v2');
  await expect(frame.locator('#frame-card .approval-card')).toBeVisible();
  const history = frame.locator('.next-nav [data-action="open-history"]');
  await history.click();
  await expect(frame.locator('.history-storage')).toBeVisible();
  await expect(frame.locator('#history-title')).toBeFocused();
  await expect(frame.locator('#frame-card')).toBeHidden();
  await frame.locator('.history-storage > summary').click();
  await expect(frame.getByRole('checkbox', { name: 'Label replies to this chat automatically' })).toBeVisible();
  await expect(frame.getByRole('button', { name: 'Captures', exact: true })).toHaveCount(0);
  await frame.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(frame.locator('#frame-card .approval-card')).toBeVisible();
  await expect(history).toBeFocused();
});

test('visible navigation and detail actions regain keyboard focus after closing secondary views', async ({ page }) => {
  const frame = await load(page, 'surface=page');
  const connection = frame.locator('.next-nav [data-action="connection"]');
  await connection.focus(); await connection.press('Enter');
  await expect(frame.locator('#connection-setup-title')).toBeFocused();
  await expect(connection).toHaveAttribute('aria-expanded', 'true');
  await frame.locator('#connection-setup-title').press('Escape');
  await expect(connection).toBeFocused();
  await expect(connection).toHaveAttribute('aria-expanded', 'false');
  await frame.locator('#measurement-details > summary').click();
  const run = frame.locator('.precision-detail-actions [data-action="open-run"]');
  await run.click();
  await expect(frame.getByRole('heading', { name: 'Current observation', exact: true })).toBeFocused();
  await frame.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(run).toBeFocused();
  const history = frame.locator('.next-nav [data-action="open-history"]');
  await history.click();
  await frame.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(history).toBeFocused();
});

test('a mounted Session ignores retired design choices and reloads optional preferences once on resume', async ({ page }) => {
  const frame = await load(page, 'surface=status', '/v2');
  await expect(frame.locator('html')).toHaveAttribute('data-design-mode', 'next');
  await expect.poll(() => state(page, 'window.previewDeviceReads')).toBe(1);
  await frame.getByRole('button', { name: 'Open MLX Scope', exact: true }).click();
  await expect.poll(() => state(page, 'window.previewOpenedSurfaces')).toEqual(['plugin:mlx-scope']);
  await page.waitForTimeout(1_100);
  expect(await state(page, 'window.previewDeviceReads')).toBe(1);
  await page.evaluate('window.setPreviewFrameHidden(true)');
  // A CSS write can be reversed before the browser delivers an intersection change. Resume only after a real
  // hidden rendering step, as a host tab change would, rather than racing the visibility observer.
  await frame.locator('html').evaluate(element => new Promise<void>(resolve => {
    const observer = new IntersectionObserver(entries => {
      if (entries.at(-1)?.isIntersecting !== false) return;
      observer.disconnect(); resolve();
    });
    observer.observe(element);
  }));
  await page.evaluate('window.setPreviewDevicePreferences({designMode:"classic",workspace:false,shells:false})');
  await expect(frame.locator('html')).toHaveAttribute('data-design-mode', 'next');
  await page.evaluate('window.setPreviewFrameHidden(false)');
  await expect(frame.locator('html')).toHaveAttribute('data-design-mode', 'next');
  await expect.poll(() => state(page, 'window.previewDeviceReads')).toBe(2);
  await frame.getByRole('button', { name: 'Open MLX Scope', exact: true }).click();
  await expect.poll(() => state(page, 'window.previewOpenedSurfaces')).toEqual(['plugin:mlx-scope', 'plugin:mlx-scope']);
  await page.waitForTimeout(1_100);
  expect(await state(page, 'window.previewDeviceReads')).toBe(2);
  expect(await state(page, 'window.previewNextWrites')).toEqual([]);
});

test('chats and subagents are the only awareness opt-in, never read agent commands, and hidden views stop the subscription', async ({ page }) => {
  const frame = await load(page, 'design=next');
  await expect(frame.locator('html')).toHaveAttribute('data-design-mode', 'next');
  const settings = frame.locator('.awareness-settings'); await settings.locator('summary').click();
  await expect(settings.getByRole('checkbox')).toHaveCount(1);
  await expect(settings.getByLabel('Agent commands')).toHaveCount(0);
  await settings.getByLabel('Chats and subagents').check();
  await expect(frame.locator('.awareness-card')).toContainText('Fixture subagent');
  await expect(frame.locator('.awareness-card')).not.toContainText('fixture_private_command_canary');
  await expect(frame.getByRole('button', { name: 'View output', exact: true })).toHaveCount(0);
  expect(await state<string[]>(page, 'window.previewNextCalls')).toContain('workspace-subscribe');
  expect(await state<string[]>(page, 'window.previewNextCalls')).not.toContain('shells-subscribe');
  expect(await state(page, 'window.previewShellReads.length')).toBe(0);
  await page.evaluate('window.setPreviewFrameHidden(true)');
  await expect.poll(() => state(page, 'window.previewSubscriptions.size')).toBe(0);
  await page.evaluate('window.setPreviewFrameHidden(false)');
  await expect(frame.locator('.awareness-card')).toContainText('Fixture active chat');
  await frame.locator('.next-nav [data-action="open-history"]').click();
  await expect.poll(() => state(page, 'window.previewSubscriptions.size')).toBe(0);
  await frame.locator('.next-nav [data-action="show-live"]').click();
  await expect(frame.locator('.awareness-card')).toContainText('Fixture subagent');
  expect(await state<string[]>(page, 'window.previewNextCalls')).not.toContain('shells-subscribe');
  expect(await state(page, 'window.previewForbiddenNextCalls')).toEqual([]);
});

const watchControl = (value: string) => ({ kind: 'select', id: 'watch', label: 'Watch', value,
  options: [{ value: 'auto', label: 'Automatic' }, { value: 'engine', label: 'Engine' }] });
const pauseControl = (label: string) => ({ kind: 'button', id: 'pause', label });

test('Session publishes Watch and Pause to the host header, hides its own toolbar, and follows header events', async ({ page }) => {
  const frame = await load(page, 'surface=status&design=next');
  const header = page.locator('#fixture-status-controls');
  await expect.poll(() => state(page, 'window.previewHeaderControls')).toEqual([watchControl('auto'), pauseControl('Pause')]);
  await expect(frame.locator('#scope')).toHaveAttribute('data-host-controls', 'true');
  await expect(frame.locator('.ws-toolbar')).toBeHidden();
  await expect(frame.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
  // This fixture's chat model is not a configured local connection, so This chat reads its busy phase, "Working".
  await expect(frame.locator('.ws-phase')).toHaveText('Working');
  await header.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(frame.locator('.ws-phase')).toHaveText('Paused');
  await expect.poll(() => state(page, 'window.previewHeaderControls')).toEqual([watchControl('auto'), pauseControl('Resume')]);
  await header.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(frame.locator('.ws-phase')).toHaveText('Working');
  await header.getByRole('combobox', { name: 'Watch', exact: true }).selectOption('engine');
  await expect(frame.locator('.ws-label')).toHaveText('Engine');
  await expect(frame.locator('.scope-choice')).toHaveValue('engine');
  await expect.poll(() => state(page, 'window.previewHeaderControls')).toEqual([watchControl('engine'), pauseControl('Pause')]);
  // The reading itself opens the snapshot details when the host offers popovers.
  await frame.getByRole('button', { name: /^Measurement details: .* · Engine$/ }).click();
  const popover = page.frameLocator('iframe[title="Scope detail popover"]');
  await expect(popover.getByRole('region', { name: 'Measurement details' })).toBeVisible();
  expect(await state(page, 'window.previewPopoverCollectorCalls')).toEqual([]);
});

test('Session keeps its own toolbar for scope, pause and details when the host rejects header controls', async ({ page }) => {
  const frame = await load(page, 'surface=status&design=next&headers=fail');
  await expect(frame.locator('.ws-toolbar')).toBeVisible();
  await expect(frame.locator('#scope')).not.toHaveAttribute('data-host-controls', 'true');
  expect(await state(page, 'window.previewHeaderControls')).toEqual([]);
  await frame.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await frame.getByRole('button', { name: 'Resume', exact: true }).click();
  await frame.getByRole('combobox', { name: 'What to watch', exact: true }).selectOption('engine');
  await expect(frame.locator('.scope-choice')).toHaveValue('engine');
  await frame.getByRole('button', { name: 'Details', exact: true }).click();
  const popover = page.frameLocator('iframe[title="Scope detail popover"]');
  await expect(popover.getByRole('region', { name: 'Measurement details' })).toBeVisible();
  expect(await state(page, 'window.previewPopoverCollectorCalls')).toEqual([]);
  await expect(frame.getByRole('button', { name: 'Open MLX Scope', exact: true })).toBeVisible();
});

test('popover surface uses the supplied snapshot and starts no monitoring or storage work', async ({ page }) => {
  await page.goto('/?sdk=next&surface=popover');
  const frame = page.frameLocator('iframe[title="MLX Scope"]');
  await expect(frame.getByRole('region', { name: 'Measurement details' })).toContainText('42 tok/s');
  expect(await state(page, 'window.previewAllRequests || 0')).toBe(0);
  expect(await state(page, 'window.previewStorage.gets')).toBe(0);
  expect(await state(page, 'window.previewNextCalls')).toEqual([]);
});


test('optional awareness saves its device choice, keeps fields this release does not use, and never revives a retired design', async ({ page }) => {
  const frame = await load(page, 'design=classic');
  await frame.locator('.awareness-settings > summary').click();
  await expect(frame.getByLabel('Chats and subagents')).not.toBeChecked();
  await frame.getByLabel('Chats and subagents').check();
  await expect.poll(() => state(page, 'window.previewNextWrites.length')).toBe(1);
  // 5.0's design and agent-command fields are written back unchanged, so an older release still reads its own choices.
  expect(await state(page, 'window.previewNextWrites')).toEqual([{ op: 'set', key: 'view.next', scope: 'device', value: { designMode: 'classic', workspace: true, shells: false } }]);
  await page.reload();
  await expect(frame.locator('html')).toHaveAttribute('data-design-mode', 'next');
  await frame.locator('.awareness-settings > summary').click();
  await expect(frame.getByLabel('Chats and subagents')).toBeChecked();
  await expect(frame.getByLabel('Agent commands')).toHaveCount(0);
});

test('steady polls leave navigation stable and navigation preserves awareness and the actual trace', async ({ page }) => {
  const frame = await load(page);
  await expect(frame.locator('#engine-trend .trace')).toBeVisible();
  await expect(frame.locator('#engine-trend .trace-endpoint')).toBeVisible();
  await frame.locator('.awareness-settings > summary').click();
  await frame.locator('.awareness-settings').getByLabel('Chats and subagents').check();
  await expect(frame.locator('.awareness-card')).toContainText('Fixture subagent');
  await frame.locator('html').evaluate(() => {
    const state = window as unknown as { navWrites: number; awareness: Element | null };
    state.navWrites = 0; state.awareness = document.querySelector('#scope-awareness');
    new MutationObserver(records => { state.navWrites += records.length; }).observe(document.querySelector('.next-nav')!, { subtree: true, attributes: true, attributeFilter: ['aria-current'] });
  });
  const requests = await state<number>(page, 'window.previewRequests');
  await expect.poll(() => state<number>(page, 'window.previewRequests')).toBeGreaterThanOrEqual(requests + 3);
  expect(await frame.locator('html').evaluate(() => (window as unknown as { navWrites: number }).navWrites)).toBe(0);
  await frame.locator('.next-nav [data-action="open-history"]').click();
  await expect(frame.locator('.next-nav [data-action="open-history"]')).toHaveAttribute('aria-current', 'page');
  await frame.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(frame.locator('#hero')).toBeVisible();
  await expect(frame.locator('#engine-trend .trace')).toBeVisible();
  await expect(frame.locator('#engine-trend .trace-endpoint')).toBeVisible();
  await expect(frame.locator('.next-nav [data-action="show-live"]')).toHaveAttribute('aria-current', 'page');
  expect(await frame.locator('html').evaluate(() => document.querySelector('#scope-awareness') === (window as unknown as { awareness: Element }).awareness && document.querySelector('#scope-awareness')?.parentElement?.id === 'next-context-activity')).toBe(true);
  await expect(frame.locator('.awareness-settings')).toHaveAttribute('open', '');
});

test('enlarged Next status prioritizes the accessible numeric reading and live media within the host height', async ({ page }) => {
  const frame = await load(page, 'surface=status&design=next&media=active');
  await page.setViewportSize({ width: 320, height: 900 });
  await page.locator('#fixture-status-controls').getByRole('combobox', { name: 'Watch', exact: true }).selectOption('engine');
  await expect(frame.locator('.media-glance').first()).toBeVisible();
  await frame.locator('html').evaluate(element => { (element as HTMLElement).style.fontSize = '24px'; });
  await expect(frame.getByRole('button', { name: /^Measurement details: .*tok\/s · Engine/ })).toBeVisible();
  await expect(frame.getByRole('button', { name: 'Open MLX Scope', exact: true })).toBeVisible();
  await expect.poll(() => frame.locator('#scope').evaluate(element => element.scrollHeight)).toBeLessThanOrEqual(320);
  expect(await frame.locator('#scope').evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await state<number[]>(page, 'window.previewHeights')).toEqual(expect.arrayContaining([expect.any(Number)]));
  expect(Math.max(...await state<number[]>(page, 'window.previewHeights'))).toBeLessThanOrEqual(320);
});

test('a device read finishing after teardown cannot restart workspace subscriptions', async ({ page }) => {
  const frame = await load(page, 'deviceStorage=held-read');
  const settings = frame.locator('.awareness-settings'); await settings.locator('summary').click();
  await settings.getByLabel('Chats and subagents').check();
  await expect(frame.locator('.awareness-card')).toContainText('Fixture subagent');
  await frame.locator('#scope').evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => state(page, 'window.previewSubscriptions.size')).toBe(0);
  const calls = await state<number>(page, 'window.previewNextCalls.length');
  await page.evaluate('window.releasePreviewDeviceRead()');
  // A later event round-trip settles the held SDK response and the controller continuation.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
  expect(await state(page, 'window.previewSubscriptions.size')).toBe(0);
  expect(await state(page, 'window.previewNextCalls.length')).toBe(calls);
});

for (const surface of ['page', 'status']) for (const runtime of ['decode', 'splash-mixed']) test(`Next ${surface} labels the ${runtime} engine speed Engine and keeps its time basis in the explanation`, async ({ page }) => {
  await page.clock.install();
  const frame = await load(page, `surface=${surface}&design=next&state=${runtime}`, '/v2');
  if (surface === 'status') await page.locator('#fixture-status-controls').getByRole('combobox', { name: 'Watch', exact: true }).selectOption('engine');
  else await frame.locator('#hero .scope-choice').selectOption('engine');
  // Splash withholds windows crossing the scope switch; deliver fresh samples past its 4 s window.
  await page.clock.runFor(5_100);
  const reading = frame.locator(surface === 'status' ? '.ws-measurement' : '.instrument-primary');
  const label = frame.locator(surface === 'status' ? '.ws-label' : '.instrument-source');
  await expect(label).toHaveText(/^Engine/);
  expect(await label.evaluate(el => Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim())).toBe('Engine');
  await expect(reading.locator('.basis')).toContainText(runtime === 'decode' ? 'average for this request' : 'Calculated · last 4.0 s');
});
