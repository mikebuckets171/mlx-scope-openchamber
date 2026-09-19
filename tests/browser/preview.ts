import { expect, test, type Page } from '@playwright/test';

const requests = (page: Page) => page.evaluate(() => (window as unknown as { previewRequests: number }).previewRequests);
const openPanel = async (page: Page, query = '') => {
  await page.goto(`/?${query}`);
  const frame = page.frameLocator('iframe');
  await frame.locator('#hardware').waitFor({ state: 'attached' });
  await expect.poll(() => requests(page)).toBeGreaterThan(0);
  return frame;
};

test('relay srcdoc transport renders packaged assets, updates theme and pauses polling', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewportSize({ width: 1160, height: 950 });
  const frame = await openPanel(page, 'transport=relay&surface=page&state=prefill');
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  const document = await page.locator('iframe').getAttribute('srcdoc');
  expect(document).toContain('http-equiv="Content-Security-Policy"');
  expect(document).toContain('https://extension.invalid/api/guests/mlx-scope/panel/index.html');
  expect(document).toMatch(/src="data:(?:application|text)\/javascript;base64,/);
  expect(document).toContain('href="data:text/css;base64,');
  expect(await page.evaluate(() => (window as any).previewTransportError)).toBe('');
  await expect(frame.locator('#connection')).toHaveText('oMLX connected');
  await expect(frame.locator('#prefill-remaining')).toHaveText('36% remaining');
  await expect(frame.locator('#prefill-counts')).toContainText('5,824 / 9,100');
  await expect(frame.locator('.masthead')).toHaveCSS('display', 'flex');
  await expect(frame.locator('html')).toHaveCSS('background-color', 'rgb(16, 21, 27)');
  await page.evaluate(() => (window as any).setPreviewTheme('light'));
  await expect(frame.locator('html')).toHaveCSS('background-color', 'rgb(247, 249, 251)');
  await expect(frame.locator('#prefill-remaining')).toHaveText('36% remaining');
  await frame.locator('#pause').click();
  await expect(frame.locator('#prefill-state')).toHaveText('Paused · last reading');
  const before = await requests(page);
  await page.waitForTimeout(1_200);
  expect(await requests(page)).toBe(before);
  await frame.locator('#pause').click();
  await expect.poll(() => requests(page)).toBeGreaterThan(before);
  await expect(frame.locator('#prefill-state')).toHaveText('Live reading');
  expect(errors).toEqual([]);
});

test('responsive layouts preserve metrics in both themes', async ({ page }, info) => {
  for (const theme of ['dark', 'light']) for (const width of [320, 430, 1160]) {
    await page.setViewportSize({ width, height: width < 900 ? 1200 : 860 });
    const frame = await openPanel(page, `theme=${theme}&surface=${width >= 900 ? 'page' : 'panel'}&long=1`);
    await expect(frame.locator('#connection')).toHaveText('oMLX connected');
    await expect(frame.locator('#ram')).toContainText('48 GiB');
    await expect(frame.locator('#swap')).toHaveText('1.1 GiB');
    const overflow = await frame.locator('main').evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow, `${theme}/${width} overflows`).toBe(false);
    // Text presence alone cannot catch a broken shared layout selector.
    for (const selector of ['.masthead', '.brand', '.connection', '.model-line', '.chart-top', 'figcaption', '.section-heading']) {
      for (const row of await frame.locator(selector).all()) {
        if (!await row.isVisible()) continue;
        await expect(row, `${theme}/${width}: ${selector}`).toHaveCSS('display', 'flex');
      }
    }
    const alignment = await frame.locator('.masthead').evaluate(el => {
      const brand = el.querySelector('.brand')!.getBoundingClientRect();
      const controls = el.querySelector('.monitor-controls')!.getBoundingClientRect();
      return { centerDelta: Math.abs(brand.y + brand.height / 2 - controls.y - controls.height / 2),
        clear: brand.right <= controls.left };
    });
    expect(alignment.centerDelta, `${theme}/${width}: header alignment`).toBeLessThan(2);
    expect(alignment.clear, `${theme}/${width}: header controls overlap the name`).toBe(true);
    for (const selector of ['.model-line', '.chart-top', 'figcaption']) {
      for (const row of await frame.locator(selector).all()) {
        const overlap = await row.evaluate(el => {
          const children = Array.from(el.children).filter(child => child.getBoundingClientRect().width > 0);
          return children.length >= 2 && children[0].getBoundingClientRect().right > children.at(-1)!.getBoundingClientRect().left;
        });
        expect(overlap, `${theme}/${width}: ${selector} labels overlap`).toBe(false);
      }
    }
    await page.screenshot({ path: info.outputPath(`${theme}-${width}.png`), fullPage: true });
  }
});

test('polling preserves controls, focus and open details', async ({ page }) => {
  const frame = await openPanel(page);
  const original = await frame.locator('#refresh').elementHandle();
  await frame.locator('.details summary').click();
  await frame.locator('.details summary').focus();
  await page.waitForTimeout(1_100);
  expect(await original!.evaluate(el => el.isConnected)).toBe(true);
  await expect(frame.locator('.details')).toHaveJSProperty('open', true);
  await expect(frame.locator('.details summary')).toBeFocused();
  await frame.locator('#refresh').click();
  await expect(frame.locator('#refresh')).toBeEnabled();
});

test('runtime states and missing readings are explicit', async ({ page }) => {
  for (const state of ['idle', 'prefill', 'queued', 'notLoaded', 'offline', 'auth', 'processing']) {
    const frame = await openPanel(page, `state=${state}`);
    await expect(frame.locator('main')).not.toContainText(/NaN|undefined/);
    if (state === 'notLoaded') await expect(frame.locator('#rate')).toHaveText('Standby');
    if (state === 'auth') await expect(frame.locator('#connection')).toHaveText('Authentication required');
    if (state === 'prefill') await expect(frame.locator('#prefill-track')).toHaveAttribute('aria-valuenow', '64');
    if (state === 'offline') {
      await expect(frame.locator('#rate')).toHaveText('—');
      await expect(frame.locator('#machine')).toBeVisible();
      await expect(frame.locator('#swap')).toHaveText('1.1 GiB');
    }
  }
  let frame = await openPanel(page, 'native=missing');
  await expect(frame.locator('#swap')).toHaveText('—');
  frame = await openPanel(page, 'system=linux');
  await expect(frame.locator('#mac-memory')).toBeHidden();
  frame = await openPanel(page, 'system=missing');
  await expect(frame.locator('#machine')).toBeHidden();
  frame = await openPanel(page, 'stats=stale');
  await expect(frame.locator('#session-stats-state')).toContainText('not live');
});

test('manual pause survives visibility changes and resumes once', async ({ page }, info) => {
  const frame = await openPanel(page);
  await frame.locator('#pause').click();
  const before = await requests(page);
  await page.waitForTimeout(1_200);
  expect(await requests(page)).toBe(before);
  await expect(frame.locator('#connection')).toHaveText('Monitoring paused');
  await expect(frame.locator('#refresh')).toBeDisabled();
  await frame.locator('main').evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(600);
  expect(await requests(page)).toBe(before);
  await page.screenshot({ path: info.outputPath('paused.png'), fullPage: true });
  await frame.locator('#pause').click();
  await expect.poll(() => requests(page)).toBeGreaterThan(before);
  await expect(frame.locator('#refresh')).toBeEnabled();
});

test('hidden panels stop polling', async ({ page }) => {
  const frame = await openPanel(page);
  await frame.locator('main').evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const before = await requests(page);
  await page.waitForTimeout(1_200);
  expect(await requests(page)).toBe(before);
  await frame.locator('main').evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => requests(page)).toBeGreaterThan(before);
});

test('stalled responses cannot leave a live rate on screen', async ({ page }) => {
  const frame = await openPanel(page, 'state=stalled');
  await expect(frame.locator('#rate')).not.toHaveText('—');
  await expect(frame.locator('#rate')).toHaveText('—', { timeout: 9_000 });
  await expect(frame.locator('#activity')).toContainText('No fresh observations');
});

test('session shortcut does not imply chat-specific measurements', async ({ page }) => {
  const frame = await openPanel(page, 'item=session&sessionTitle=Private%20chat');
  await expect(frame.locator('main')).not.toContainText('Private chat');
});

test('full-page history renders without page or console errors', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewportSize({ width: 1160, height: 860 });
  const frame = await openPanel(page, 'surface=page');
  await expect(frame.locator('#cpu-history')).toHaveAttribute('d', /L/, { timeout: 7_000 });
  await page.waitForTimeout(5_000);
  await page.screenshot({ path: info.outputPath('workspace.png'), fullPage: true });
  expect(errors).toEqual([]);
});


test('energy-saving control reduces repeated polling without pausing the model', async ({ page }) => {
  const frame = await openPanel(page);
  await frame.locator('#efficiency').click();
  await expect(frame.locator('#efficiency')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(1_000);
  const before = await requests(page);
  await page.waitForTimeout(1_500);
  expect(await requests(page)).toBe(before);
  await expect(frame.locator('#pause')).toHaveAttribute('aria-pressed', 'false');
  await frame.locator('#refresh').click();
  await expect.poll(() => requests(page)).toBeGreaterThan(before);
  await expect(frame.locator('#connection')).toHaveText('oMLX connected');
});


test('prefill remaining and counts stay visible in compact mode and clear on generation', async ({ page }, info) => {
  for (const theme of ['dark', 'light']) {
    await page.setViewportSize({ width: 430, height: 1000 });
    const frame = await openPanel(page, `theme=${theme}&state=prefill`);
    await expect(frame.locator('#prefill-remaining')).toHaveText('36% remaining');
    await expect(frame.locator('#prefill-counts')).toContainText('5,824 / 9,100');
    await expect(frame.locator('#prefill-track')).toHaveAttribute('aria-valuetext', /36% remaining/);
    await frame.locator('#compact').click();
    await expect(frame.locator('#signal')).toBeHidden();
    await expect(frame.locator('#prefill-remaining')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`prefill-${theme}.png`), fullPage: true });
    await frame.locator('#pause').click();
    await expect(frame.locator('#prefill-state')).toHaveText('Paused · last reading');
    await frame.locator('#pause').click();
    await page.evaluate(() => (window as unknown as { setPreviewState: (state: string) => void }).setPreviewState('decode'));
    await frame.locator('#refresh').click();
    await expect(frame.locator('#prefill-progress')).toBeHidden();
    await expect(frame.locator('#request-output')).toContainText('output tokens');
    await page.evaluate(() => sessionStorage.clear());
  }
});

test('invalid or missing prefill counts are not zero; stale progress is labelled', async ({ page }) => {
  for (const state of ['prefill-missing', 'prefill-malformed', 'prefill-stale']) {
    const frame = await openPanel(page, `state=${state}`);
    if (state === 'prefill-stale') {
      await expect(frame.locator('#prefill-state')).toHaveText('Waiting for progress');
      await expect(frame.locator('#prefill-track')).toHaveAttribute('aria-valuetext', /not live/);
    } else {
      await expect(frame.locator('#prefill-remaining')).toHaveText('Progress unavailable');
      await expect(frame.locator('#prefill-track')).not.toHaveAttribute('aria-valuenow');
    }
  }
});

test('view choices survive reload with no repeated storage writes or extra polling', async ({ page }) => {
  let frame = await openPanel(page, 'state=prefill');
  await frame.locator('#compact').click(); await frame.locator('#efficiency').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { previewWrites: number }).previewWrites)).toBe(2);
  await page.reload(); frame = page.frameLocator('iframe');
  await expect(frame.locator('#compact')).toHaveAttribute('aria-pressed', 'true');
  await expect(frame.locator('#efficiency')).toHaveAttribute('aria-pressed', 'true');
  await expect(frame.locator('#prefill-remaining')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { previewWrites: number }).previewWrites)).toBe(0);
});

test('copy stats uses host clipboard and reports failure without claiming success', async ({ page }) => {
  let frame = await openPanel(page, 'state=prefill&long=1&sessionTitle=PRIVATE');
  const before = await requests(page);
  await frame.locator('#pause').click(); await frame.getByRole('button', { name: 'Share', exact: true }).click(); await frame.getByRole('menuitem', { name: 'Copy stats', exact: true }).click();
  await expect(frame.locator('#action-status')).toContainText('Stats copied');
  const copied = await page.evaluate(() => (window as unknown as { previewCopied: string }).previewCopied);
  expect(copied).toContain('36% remaining'); expect(copied).toContain('held observations');
  expect(copied).not.toMatch(/PRIVATE|publisher|request_id|api_key/);
  expect(await requests(page)).toBe(before);
  frame = await openPanel(page, 'clipboard=fail');
  await frame.getByRole('button', { name: 'Share', exact: true }).click(); await frame.getByRole('menuitem', { name: 'Copy stats', exact: true }).click();
  await expect(frame.locator('#action-status')).toContainText('Could not copy');
});

test('storage failures never block monitoring or claim persisted preferences', async ({ page }) => {
  const frame = await openPanel(page, 'storage=fail');
  await frame.locator('#compact').click();
  await expect(frame.locator('#compact')).toHaveAttribute('aria-pressed', 'true');
  await expect(frame.locator('#action-status')).toContainText('could not save');
  await expect(frame.locator('#connection')).toHaveText('oMLX connected');
});

test('energy saving does not turn the throughput chart into disconnected invisible points', async ({ page }) => {
  const frame = await openPanel(page);
  await frame.locator('#efficiency').click();
  await expect.poll(() => frame.locator('#trace path').evaluateAll(paths => paths.some(path => /L/.test(path.getAttribute('d') ?? ''))), { timeout: 9000 }).toBe(true);
});


test('prefill layout is legible from a narrow panel to a full page', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  for (const theme of ['dark', 'light']) for (const width of [320, 1160]) {
    await page.setViewportSize({ width, height: width < 900 ? 1200 : 950 });
    const frame = await openPanel(page, `theme=${theme}&state=prefill&surface=${width < 900 ? 'panel' : 'page'}`);
    await expect(frame.locator('#prefill-remaining')).toHaveText('36% remaining');
    await expect(frame.locator('#prefill-completed')).toHaveText('64% complete');
    expect(await frame.locator('main').evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: info.outputPath(`prefill-${theme}-${width}.png`), fullPage: true });
    await page.evaluate(() => (window as unknown as { setPreviewState: (state: string) => void }).setPreviewState('prefill-missing'));
    await frame.locator('#refresh').click();
    await expect(frame.locator('#prefill-remaining')).toHaveText('Progress unavailable');
    expect(await frame.locator('main').evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  }
  expect(errors).toEqual([]);
});

test('prefill stage estimate accompanies remaining percent and disappears on pause or stale progress', async ({ page }) => {
  const frame = await openPanel(page, 'state=prefill');
  await expect(frame.locator('#prefill-eta')).toHaveText('~20s');
  await expect(frame.locator('#prefill-remaining')).toHaveText('36% remaining');
  await frame.locator('#compact').click(); await expect(frame.locator('#prefill-estimate')).toBeVisible();
  await frame.locator('#pause').click(); await expect(frame.locator('#prefill-estimate')).toBeHidden();
  await frame.locator('#pause').click();
  await page.evaluate(() => (window as any).setPreviewState('prefill-stale'));
  await frame.locator('#refresh').click();
  await expect(frame.locator('#prefill-estimate')).toBeHidden();
  await expect(frame.locator('#prefill-remaining')).toHaveText('36% remaining');
});

test('recent speed uses observations and is cleared on monitoring gaps', async ({ page }) => {
  const frame = await openPanel(page);
  await expect(frame.locator('#window-speed')).toContainText('tok/s', { timeout: 7000 });
  await expect(frame.locator('#window-span')).toContainText('Observed over');
  await frame.locator('#pause').click(); await expect(frame.locator('#recent-speed')).toBeHidden();
  await expect(frame.locator('#recent-list')).toContainText('Monitoring gap');
  await frame.locator('#pause').click();
  await expect(frame.locator('#window-speed')).toHaveText('Gathering samples…');
});

test('recent generations capture last seen values, copy sanitized observations, and clear without resetting runtime', async ({ page }) => {
  const frame = await openPanel(page, 'long=1');
  await page.evaluate(() => (window as any).setPreviewState('idle'));
  await frame.locator('#refresh').click();
  await expect(frame.locator('#recent-list .generation-row')).toHaveCount(1);
  await expect(frame.locator('#recent-list')).toContainText('tokens last seen');
  const before = await requests(page);
  await frame.getByRole('tab', {name:'Compare',exact:true}).click();
  await frame.locator('#copy-recent').click();
  await expect.poll(() => page.evaluate(() => (window as any).previewCopied)).toContain('not final');
  const copied = await page.evaluate(() => (window as any).previewCopied);
  expect(copied).toContain('not final'); expect(copied).not.toMatch(/publisher|large-context|request_id|api_key/);
  await frame.locator('#clear-recent').click();
  await expect(frame.locator('#recent-list .generation-row')).toHaveCount(0);
  await expect(frame.locator('#copy-recent')).toBeDisabled();
  await expect(frame.locator('#action-status')).toContainText('Runtime statistics were not changed');
  expect(await requests(page)).toBeLessThanOrEqual(before + 1);
});

test('resident roster reveals concurrent model activity with text-only labels', async ({ page }) => {
  const frame = await openPanel(page, 'multi=1');
  await expect(frame.locator('#resident-list .resident-row')).toHaveCount(2);
  await expect(frame.locator('#resident-list')).toContainText('77% left');
  await expect(frame.locator('#rate')).toHaveText('—');
  await expect(frame.locator('#activity')).toContainText('Concurrent requests');
  await page.evaluate(() => (window as any).setPreviewOverride({ residentModels: [{ id:'<img src=x onerror=alert(1)>', phase:'idle', activeRequests:0 }] }));
  await frame.locator('#refresh').click();
  await expect(frame.locator('#resident-list img')).toHaveCount(0);
  await expect(frame.locator('#resident-list')).toContainText('<img');
  await page.evaluate(() => { (window as any).setPreviewOverride({}); (window as any).setPreviewState('offline'); });
  await frame.locator('#refresh').click(); await expect(frame.locator('#resident-section')).toBeHidden();
});

test('cache lens separates reused input from prefill and exposes unavailable values', async ({ page }) => {
  const frame = await openPanel(page, 'state=prefill');
  await expect(frame.locator('#cache-reuse-count')).toHaveText('43,000');
  await expect(frame.locator('#cache-new-count')).toHaveText('9,100');
  await expect(frame.locator('#cache-input-bar')).toHaveAttribute('aria-label', /43,000.*9,100/);
  await page.evaluate(() => (window as any).setPreviewOverride({cachedTokens: null}));
  await frame.locator('#refresh').click();
  await expect(frame.locator('#cache-new-count')).toHaveText('—');
  await expect(frame.locator('#cache-input-bar')).toHaveAttribute('data-available', 'false');
});

test('enhanced workspace and panel render without overflow, runtime errors or hidden prefill', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  for (const theme of ['dark', 'light']) for (const width of [320, 1160]) {
    await page.setViewportSize({width, height: 1400});
    const frame = await openPanel(page, `theme=${theme}&multi=resident&surface=${width === 1160 ? 'page' : 'panel'}`);
    if (await frame.locator('#compact').getAttribute('aria-pressed') === 'true') await frame.locator('#compact').click();
    await expect(frame.locator('#compact')).toHaveAttribute('aria-pressed', 'false');
    await expect(frame.locator('#cache-lens')).toBeVisible();
    await expect(frame.locator('#resident-section')).toBeVisible();
    await expect(frame.locator('#recent-generations')).toBeHidden();
    await page.evaluate(() => (window as any).setPreviewEpoch(2));
    await frame.locator('#refresh').click();
    await expect(frame.locator('#recent-list .generation-row')).toHaveCount(1);
    await page.evaluate(() => (window as any).setPreviewState('prefill'));
    await frame.locator('#refresh').click();
    await expect(frame.locator('#prefill-remaining')).toHaveText('36% remaining');
    await expect(frame.locator('#prefill-estimate')).toBeVisible();
    expect(await frame.locator('main').evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    // Capture complete iframe contents after resizing the test viewport.
    const height = await frame.locator('main').evaluate(el => Math.ceil(el.getBoundingClientRect().height) + 40);
    await page.setViewportSize({width, height});
    await frame.locator('main').screenshot({path: info.outputPath(`enhanced-${theme}-${width}.png`)});
    if (width === 320) {
      await frame.locator('#compact').click();
      await expect(frame.locator('#prefill-estimate')).toBeVisible();
      await expect(frame.locator('#cache-lens')).toBeHidden();
      await frame.locator('main').screenshot({path: info.outputPath(`enhanced-compact-${theme}.png`)});
    }
  }
  expect(errors).toEqual([]);
});

test('new observation history is not persisted across reloads', async ({ page }) => {
  const frame = await openPanel(page);
  await frame.locator('#pause').click(); await expect(frame.locator('#recent-list .generation-row')).toHaveCount(1);
  const writes = await page.evaluate(() => (window as any).previewWrites);
  expect(writes).toBe(0);
  await page.reload();
  await expect(page.frameLocator('iframe').locator('#recent-list .generation-row')).toHaveCount(0);
});

test('copy recent handles denied clipboard without claiming success', async ({ page }) => {
  const frame = await openPanel(page, 'clipboard=fail');
  await frame.locator('#pause').click(); await frame.getByRole('tab', {name:'Compare',exact:true}).click(); await frame.locator('#copy-recent').click();
  await expect(frame.locator('#action-status')).toContainText('Could not copy observations');
});

test('sharing is a quiet menu built with SDK buttons and appends a sanitized draft without sending', async ({page}) => {
  const frame = await openPanel(page, 'chat=1');
  await expect(frame.locator('#chamber-context')).toHaveCount(0);
  const share = frame.getByRole('button', {name:'Share', exact:true});
  await expect(frame.getByRole('menuitem')).toHaveCount(0);
  await share.click();
  await frame.getByRole('menuitem', {name:'Add to chat draft'}).click();
  await expect(frame.locator('#action-status')).toContainText('Nothing was sent automatically');
  const draft = await page.evaluate(() => (window as any).previewComposed);
  expect(draft.mode).toBe('append'); expect(draft.text).toContain('not a selected chat');
  expect(draft.text).not.toMatch(/Local coding session|Qwen/);
  expect(await page.evaluate(() => (window as any).previewUnexpectedSends)).toBe(0);
  await page.evaluate(() => (window as any).setPreviewSession(null));
  await share.click();
  await expect(frame.getByRole('menuitem', {name:'Add to chat draft'})).toBeDisabled();
});

test('draft failures do not claim success; sharing without a selected chat is unavailable', async ({page}) => {
  let frame = await openPanel(page);
  await frame.getByRole('button', {name:'Share',exact:true}).click();
  await expect(frame.getByRole('menuitem',{name:'Add to chat draft'})).toBeDisabled();
  frame = await openPanel(page,'chat=1&compose=fail');
  await frame.getByRole('button',{name:'Share',exact:true}).click();
  await frame.getByRole('menuitem',{name:'Add to chat draft'}).click();
  await expect(frame.locator('#action-status')).toContainText('Could not confirm');
  await frame.getByRole('button',{name:'Share',exact:true}).click();
  await expect(frame.getByRole('menuitem',{name:'Add to chat draft'})).toBeEnabled();
});

test('performance capture observes, pins, copies, and clears without running inference',async({page})=>{
  const frame=await openPanel(page,'chat=1');
  await frame.getByRole('tab', {name:'Compare',exact:true}).click();
  await frame.locator('#capture-start').click();
  await expect(frame.locator('#capture')).toHaveAttribute('data-recording','true');
  await expect(frame.locator('#capture-speed')).toContainText('tok/s');
  await frame.locator('#capture-stop').click();
  await expect(frame.locator('#capture-state')).toHaveText('Partial capture');
  await expect(frame.locator('#capture-speed')).toContainText('tok/s');
  await frame.locator('#capture-pin').click();await expect(frame.locator('#capture-baseline')).toBeVisible();
  await frame.locator('#capture-copy').click();
  await expect.poll(() => page.evaluate(() => (window as any).previewCopied)).toContain('performance observations');
  const text=await page.evaluate(()=>(window as any).previewCopied);
  expect(text).toContain('performance observations');expect(text).not.toContain('Qwen');expect(text).not.toContain('synthetic-chat');
  expect(await page.evaluate(()=>(window as any).previewWrites)).toBe(0);
  expect(await page.evaluate(()=>(window as any).previewUnexpectedSends)).toBe(0);
  await frame.locator('#capture-clear').click();await expect(frame.locator('#capture-results')).toBeHidden();
});

test('pause terminates a capture honestly and context headroom has the correct scope',async({page})=>{
  const frame=await openPanel(page);
  await expect(frame.locator('#context-headroom')).toHaveAttribute('title',/not OpenCode/);
  await expect(frame.locator('#context-accounted')).toContainText('prompt + output');
  await frame.getByRole('tab', {name:'Compare',exact:true}).click();
  await frame.locator('#capture-start').click();await frame.locator('#pause').click();
  await expect(frame.locator('#capture-state')).toHaveText('Partial capture');
  await expect(frame.locator('#capture-note')).toContainText('Monitoring interrupted');
  await expect(frame.locator('#capture-start')).toBeDisabled();
  await frame.locator('#pause').click();await expect(frame.locator('#capture-start')).toBeEnabled();
});

test('coordinated monitor layout keeps new controls legible with prefill visible',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  for(const theme of ['dark','light'])for(const width of [320,1160]){
    await page.setViewportSize({width,height:1500});
    const frame=await openPanel(page,`chat=1&theme=${theme}&multi=resident&surface=${width>900?'page':'panel'}`);
    if(await frame.locator('#compact').getAttribute('aria-pressed')==='true')await frame.locator('#compact').click();
    await frame.getByRole('tab', {name:'Compare',exact:true}).click();
  await frame.locator('#capture-start').click();await expect(frame.locator('#capture-speed')).toContainText('tok/s');await frame.locator('#capture-stop').click();
    await frame.locator('#capture-pin').click();
    await frame.getByRole('tab', {name:'Live',exact:true}).click();
    await page.evaluate(()=>(window as any).setPreviewState('prefill'));await frame.locator('#refresh').click();
    await expect(frame.locator('#prefill-remaining')).toHaveText('36% remaining');
    await expect(frame.getByRole('button', {name:'Share',exact:true})).toBeVisible();
    await expect(frame.locator('#chamber-context')).toHaveCount(0);
    expect(await frame.locator('main').evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    const height=await frame.locator('main').evaluate(el=>Math.ceil(el.getBoundingClientRect().height)+40);
    await page.setViewportSize({width,height});
    await frame.locator('main').screenshot({path:info.outputPath(`coordinated-${theme}-${width}.png`)});
    if(width===320){await frame.locator('#compact').click();await expect(frame.locator('#prefill-remaining')).toBeVisible();await expect(frame.locator('#capture')).toBeHidden();await frame.locator('main').screenshot({path:info.outputPath(`coordinated-compact-${theme}.png`)});}
  }
  expect(errors).toEqual([]);
});


test('Share preserves keyboard focus, responds to session changes, and survives monitoring updates', async ({page}) => {
  const frame = await openPanel(page, 'chat=1');
  const share = frame.getByRole('button',{name:'Share',exact:true});
  await share.focus(); await share.press('Enter');
  await expect(frame.getByRole('menu')).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(frame.getByRole('menu')).toBeVisible();
  await frame.getByRole('menu').press('Escape');
  await expect(share).toBeFocused();
  await expect(frame.getByRole('menu')).toHaveCount(0);
  await page.evaluate(() => (window as any).setPreviewSession(null));
  await share.press('Enter');
  await expect(frame.getByRole('menuitem',{name:'Add to chat draft'})).toBeDisabled();
  expect(await page.evaluate(() => (window as any).previewComposed)).toBeNull();
});

test('live host theme changes update the existing view without restarting monitoring', async ({page}, info) => {
  await page.setViewportSize({width:1160,height:1350});
  const frame = await openPanel(page,'state=prefill&chat=1&surface=page');
  await frame.locator('#pause').click();
  const count = await requests(page);
  const themes = ['dark','light','violet','sand'];
  for (const theme of themes) {
    await page.evaluate(value => (window as any).setPreviewTheme(value), theme);
    const expected = await page.evaluate(() => (window as any).previewTheme);
    await expect.poll(() => frame.locator('.scope').evaluate(el => getComputedStyle(el).getPropertyValue('--oc-primary-text').trim())).toBe(expected.tokens.primaryText);
    await expect(frame.locator('#prefill-remaining')).toHaveText('36% remaining');
    await expect(frame.locator('#pause')).toHaveAttribute('aria-pressed','true');
    expect(await frame.locator('main').evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const height = await frame.locator('main').evaluate(el => Math.ceil(el.getBoundingClientRect().height) + 40);
    await page.setViewportSize({width:1160,height});
    await frame.locator('main').screenshot({path:info.outputPath(`theme-${theme}-1160.png`)});
  }
  expect(await requests(page)).toBe(count);
  await page.setViewportSize({width:320,height:1200});
  await frame.locator('#compact').click();
  await frame.getByRole('button',{name:'Share',exact:true}).click();
  await expect(frame.getByRole('menuitem',{name:'Add to chat draft'})).toBeVisible();
  expect(await frame.locator('main').evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await frame.locator('main').screenshot({path:info.outputPath('share-compact-sand.png')});
});


test('Share remains anchored, closes outside, and does not shift the monitor', async ({ page }, info) => {
  await page.setViewportSize({width:320,height:1200});
  const frame = await openPanel(page,'chat=1&state=prefill');
  const share = frame.getByRole('button',{name:'Share',exact:true});
  const before = await frame.locator('#model').boundingBox();
  await share.click();
  const menu = frame.getByRole('menu');
  await expect(menu).toBeVisible();
  expect(await frame.locator('#model').boundingBox()).toEqual(before);
  const bounds = await menu.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  await frame.getByRole('menuitem',{name:'Copy stats',exact:true}).press('ArrowDown');
  await expect(frame.getByRole('menuitem',{name:'Add to chat draft'})).toBeFocused();
  await frame.getByRole('menuitem',{name:'Add to chat draft'}).press('Home');
  await expect(frame.getByRole('menuitem',{name:'Copy stats',exact:true})).toBeFocused();
  await frame.locator('main').screenshot({path:info.outputPath('share-narrow.png')});
  // The popup overlays the model heading; dismiss from the unobstructed masthead.
  await frame.locator('#scope-title').click();
  await expect(menu).toBeHidden();
  expect(await page.evaluate(() => (window as any).previewComposed)).toBeNull();
  expect(await page.evaluate(() => (window as any).previewCopied)).toBe('');
});

test('history inspection keeps a recorded value selected without extra polling', async ({page}, info) => {
  const frame = await openPanel(page);
  await page.waitForTimeout(1_200);
  await frame.locator('#pause').click();
  const before = await requests(page);
  const history = frame.getByRole('slider',{name:'Inspect throughput history'});
  await history.focus(); await history.press('Home');
  await expect(frame.locator('#history-reading')).toContainText('tok/s');
  await expect(history).toHaveAttribute('aria-valuenow','0');
  const oldest = await frame.locator('#history-reading').textContent();
  await history.press('End');
  await expect(frame.locator('#history-reading')).not.toHaveText(oldest!);
  await expect(frame.locator('#inspect-dot')).not.toHaveAttribute('hidden','');
  await history.press('Escape');
  await expect(frame.locator('#history-reading')).toContainText('Point to inspect');
  await expect(frame.locator('#inspect-dot')).toHaveAttribute('hidden','');
  expect(await requests(page)).toBe(before);
  await history.press('Home');
  await frame.locator('main').screenshot({path:info.outputPath('history-inspection.png')});
});

test('connection help uses the supported status call only on demand', async ({page}) => {
  for (const status of ['ready','starting','stopped','failed']) {
    const frame = await openPanel(page,`state=offline&service=${status}`);
    expect(await page.evaluate(() => (window as any).previewStatusChecks)).toBe(0);
    await frame.locator('#pause').click();
    const before = await requests(page);
    await frame.locator('#connection-help summary').click();
    await frame.locator('#check-connection').click();
    const expected = {ready:'If readings are missing',starting:'starting',stopped:'stopped',failed:'could not start'}[status]!;
    await expect(frame.locator('#connection-result')).toContainText(expected);
    await expect(frame.locator('#check-connection')).toBeEnabled();
    expect(await page.evaluate(() => (window as any).previewStatusChecks)).toBe(1);
    expect(await requests(page)).toBe(before);
  }
});

test('denied connection checks do not expose raw errors or change runtime state', async ({page}) => {
  const frame = await openPanel(page,'denied=1&state=offline');
  await frame.locator('#connection-help summary').click();
  await frame.locator('#check-connection').click();
  await expect(frame.locator('#connection-result')).toContainText('Approve');
  await expect(frame.locator('main')).not.toContainText('fixture detail');
  await frame.locator('#connection-guide').click();
  await expect.poll(() => page.evaluate(() => (window as any).previewOpenedURL)).toMatch(/^https:\/\/github.com\/mikebuckets171\/mlx-scope-openchamber\/blob\/v[\d.]+\/docs\/CONFIGURATION.md$/);
  expect(await page.evaluate(() => (window as any).previewUnexpectedSends)).toBe(0);
});

test('returning to a hidden panel with a pending request never presents old speed as live', async ({page}) => {
  const frame = await openPanel(page,'state=prefill');
  await expect(frame.locator('#prefill-remaining')).toHaveText('36% remaining');
  await frame.locator('main').evaluate(() => {
    Object.defineProperty(document,'hidden',{configurable:true,value:true});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.evaluate(() => { (window as any).previewHold=true; });
  await frame.locator('main').evaluate(() => {
    Object.defineProperty(document,'hidden',{configurable:true,value:false});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(frame.locator('#rate')).toHaveText('—');
  await expect(frame.locator('#prefill-state')).toHaveText('Refreshing · last reading');
  await expect(frame.locator('#prefill-estimate')).toBeHidden();
  await expect(frame.locator('#capture-start')).toBeDisabled();
  await frame.locator('#compact').click();
  await frame.locator('#compact').click();
  await expect(frame.locator('#rate')).toHaveText('—');
  await expect(frame.locator('#prefill-state')).toHaveText('Refreshing · last reading');
  await frame.getByRole('button',{name:'Share',exact:true}).click();
  await frame.getByRole('menuitem',{name:'Copy stats',exact:true}).click();
  await expect(frame.locator('#action-status')).toContainText('Stats copied');
  expect(await page.evaluate(() => (window as any).previewCopied)).toContain('refreshing — held observations');
});

test('an unopened host shows setup guidance rather than an endless loading claim', async ({page}) => {
  await page.clock.install();
  await page.goto('/?nohost=1');
  const frame=page.frameLocator('iframe');
  await expect(frame.locator('#refresh')).toBeDisabled();
  await page.clock.fastForward(6_100);
  await expect(frame.locator('#connection')).toHaveText('Waiting for OpenChamber');
  await expect(frame.locator('#activity')).toContainText('extension panel');
  expect(await requests(page)).toBe(0);
});

test('host context refreshes preserve mounted controls and one monitoring loop', async ({page}) => {
  const frame=await openPanel(page,'state=decode');
  const original=await frame.locator('#history-inspector').elementHandle();
  const before=await requests(page);
  await page.evaluate(() => { for(let i=0;i<20;i++) (window as any).setPreviewTheme(i%2?'light':'dark'); });
  await page.waitForTimeout(1_050);
  expect(await original!.evaluate(el=>el.isConnected)).toBe(true);
  expect((await requests(page))-before).toBeLessThanOrEqual(4);
  expect(await page.evaluate(()=>(window as any).previewStatusChecks)).toBe(0);
});


test('a restored browser view waits for fresh readings even without a visibility event', async ({page}) => {
  const frame = await openPanel(page, 'state=prefill');
  await expect(frame.locator('#prefill-state')).toHaveText('Live reading');
  await page.evaluate(() => { (window as any).previewHold = true; });
  await frame.locator('main').evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
    window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
  });
  await expect(frame.locator('#rate')).toHaveText('—');
  await expect(frame.locator('#prefill-state')).toHaveText('Refreshing · last reading');
  await expect(frame.locator('#prefill-estimate')).toBeHidden();
  await expect(frame.locator('#capture-start')).toBeDisabled();
  await frame.locator('#compact').click();
  await frame.locator('#compact').click();
  await expect(frame.locator('#rate')).toHaveText('—');
});


test('DFlash shows observed output, never invents a request average or prefill percentage', async ({page}, info) => {
  const frame = await openPanel(page, 'state=dflash-preparing');
  await expect(frame.locator('#phase')).toHaveText('Processing');
  await expect(frame.locator('#prefill-progress')).toBeHidden();
  await expect(frame.locator('#activity')).toContainText('does not report prefill percentage');
  await page.evaluate(() => { (window as any).setPreviewState('dflash'); });
  await expect(frame.locator('#phase')).toHaveText('Generating');
  await expect(frame.locator('#unit')).toContainText('recent output');
  await expect(frame.locator('#chart-title')).toHaveText('Generation · recent output');
  await expect(frame.locator('#request-output')).toContainText('output tokens');
  await expect(frame.locator('#prefill-progress')).toBeHidden();
  await expect(frame.locator('#reuse')).toHaveText('—');
  await frame.locator('#pause').click();
  await expect(frame.locator('#connection')).toHaveText('Monitoring paused');
  await expect(frame.locator('#phase')).toHaveText('Paused');
  await expect(frame.locator('#unit')).toHaveText('Frozen observation');
  const frozenRate = await frame.locator('#rate').textContent();
  expect(frozenRate).toMatch(/[0-9]/);
  const pausedRequests = await requests(page);
  await page.waitForTimeout(1_000);
  await expect(frame.locator('#rate')).toHaveText(frozenRate!);
  expect(await requests(page)).toBe(pausedRequests);
  await frame.locator('#pause').click();
  await expect(frame.locator('#unit')).toContainText('recent output');
  await page.screenshot({path:info.outputPath('dflash-observed.png'),fullPage:true});
  await page.evaluate(() => { (window as any).setPreviewState('prefill'); (window as any).setPreviewEpoch(2); });
  await expect(frame.locator('#prefill-remaining')).toHaveText('36% remaining');
  await expect(frame.locator('#chart-title')).toHaveText('Prefill · reported speed');
  await expect(frame.locator('#recent-speed')).toBeHidden();
});

test('workspace tabs use keyboard navigation and Saved suspends monitoring until Live is restored', async ({page}) => {
  const frame = await openPanel(page,'state=prefill');
  const live = frame.getByRole('tab',{name:'Live',exact:true});
  await live.focus(); await live.press('ArrowRight');
  await expect(frame.getByRole('tab',{name:'Compare',exact:true})).toBeFocused();
  await expect(frame.locator('#view-compare')).toBeVisible();
  await frame.getByRole('tab',{name:'Compare',exact:true}).press('ArrowRight');
  await expect(frame.locator('#view-saved')).toBeVisible();
  const before = await requests(page); await page.waitForTimeout(1200); expect(await requests(page)).toBe(before);
  await frame.getByRole('tab',{name:'Saved',exact:true}).press('Home');
  await expect(live).toBeFocused(); await expect.poll(() => requests(page)).toBeGreaterThan(before);
  await expect(frame.locator('#prefill-state')).toHaveText('Live reading');
});

test('saved snapshots are manual, sanitized, persistent and individually deletable', async ({page}) => {
  const frame = await openPanel(page,'state=prefill&long=1&chat=1');
  expect(await page.evaluate(() => (window as any).previewWrites)).toBe(0);
  await frame.locator('#save-snapshot').click();
  await expect(frame.locator('#action-status')).toContainText('Observation saved');
  const stored = await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('observation.v1.')).map(key => sessionStorage.getItem(key)).join(''));
  expect(stored).not.toMatch(/Qwen|publisher|private|request_id|traceEpoch|api_key/);
  await frame.getByRole('tab',{name:'Saved',exact:true}).click();
  await expect(frame.locator('.saved-row')).toHaveCount(1);
  await page.reload(); const restored = page.frameLocator('iframe');
  await restored.getByRole('tab',{name:'Saved',exact:true}).click();
  await expect(restored.locator('.saved-row')).toHaveCount(1);
  await restored.locator('.saved-row summary').click();
  const processed = restored.locator('.saved-measurements tr').filter({ has: restored.getByRole('rowheader', { name: /Prefill processed/ }) });
  await expect(processed.getByRole('cell')).toHaveText('5,824');
  await restored.locator('.saved-row').getByRole('button',{name:'Copy',exact:true}).click();
  await expect.poll(() => page.evaluate(() => (window as any).previewCopied)).toContain('Differences do not establish causality');
  await restored.getByRole('button',{name:/Delete runtime snapshot/}).click();
  await expect(restored.locator('.saved-row')).toHaveCount(0);
  await expect(restored.getByRole('tab',{name:'Saved',exact:true})).toBeFocused();
  expect(await page.evaluate(() => (window as any).previewUnexpectedSends)).toBe(0);
});

test('saved storage and clipboard failures are honest and never block Live', async ({page}) => {
  let frame = await openPanel(page,'storage=fail');
  await frame.locator('#save-snapshot').click();
  await expect(frame.locator('#action-status')).toContainText('Nothing was confirmed');
  await frame.getByRole('tab',{name:'Saved',exact:true}).click();
  await expect(frame.locator('#saved-state')).toContainText('unavailable');
  await frame.getByRole('tab',{name:'Live',exact:true}).click();
  await expect(frame.locator('#connection')).toHaveText('oMLX connected');
  frame = await openPanel(page,'clipboard=fail');
  await frame.locator('#save-snapshot').click(); await expect(frame.locator('#action-status')).toContainText('Observation saved');
  await frame.getByRole('tab',{name:'Saved',exact:true}).click();
  await frame.locator('.saved-row').getByRole('button',{name:'Copy',exact:true}).click();
  await expect(frame.locator('#action-status')).toContainText('clipboard was not confirmed');
  await frame.locator('#saved-clear').click(); await expect(frame.locator('.saved-row')).toHaveCount(0);
});

test('Share feedback preserves layout and a draft append preserves existing text', async ({page}) => {
  const frame = await openPanel(page,'chat=1&state=prefill');
  await frame.locator('#pause').click();
  const before = await frame.locator('#model').boundingBox();
  await frame.getByRole('button',{name:'Share',exact:true}).click();
  await frame.getByRole('menuitem',{name:'Add to chat draft'}).click();
  await expect(frame.locator('#action-status')).toContainText('Nothing was sent');
  expect(await page.evaluate(() => (window as any).previewDraft)).toMatch(/^Existing draft\n\nMLX Scope/);
  expect(await frame.locator('#model').boundingBox()).toEqual(before);
  await expect(frame.getByRole('button',{name:'Share',exact:true})).toBeFocused();
});

test('a save clicked while a previous Saved load is pending is queued and confirmed', async ({page}) => {
  const frame = await openPanel(page,'state=prefill&storage=slow');
  await frame.getByRole('tab',{name:'Saved',exact:true}).click();
  await frame.getByRole('tab',{name:'Live',exact:true}).click();
  await expect(frame.locator('#prefill-state')).toHaveText('Live reading');
  await frame.locator('#save-snapshot').click();
  await expect(frame.locator('#action-status')).toContainText('Observation saved');
  await frame.getByRole('tab',{name:'Saved',exact:true}).click();
  await expect(frame.locator('.saved-row')).toHaveCount(1);
});
