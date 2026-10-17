import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type FrameLocator, type Page } from '@playwright/test';

// 3.2 has one column and secondary views with Back; these replace the 3.1 Live/History tabs.
const toColumn = async (frame: FrameLocator): Promise<void> => {
  const back = frame.getByRole('button', { name: 'Back', exact: true }); if (await back.isVisible()) await back.click();
};
const toHistory = async (frame: FrameLocator): Promise<void> => { await toColumn(frame); await frame.getByRole('button', { name: 'History', exact: true }).click(); };

// Flush iframe -> host -> iframe messages between clock ticks, so every synthetic reading is actually observed.
const advance = async (page: Page, milliseconds: number): Promise<void> => {
  const panel = page.mainFrame().childFrames()[0]!;
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 500) {
    await page.clock.runFor(500);
    await panel.evaluate(() => new Promise<void>(resolve => {
      const receive = (event: MessageEvent) => {
        if (event.source !== parent || event.data !== 'design-pong') return;
        removeEventListener('message', receive); resolve();
      };
      addEventListener('message', receive); parent.postMessage('design-ping', '*');
    }));
  }
};
const screenshot = async (page: Page, path: string): Promise<void> => {
  const scope = page.frameLocator('iframe').locator('#scope');
  const size = await scope.boundingBox();
  if (!size) throw new Error('Missing preview surface');
  // An element screenshot cannot reveal content clipped by the containing iframe.
  await page.setViewportSize({ width: page.viewportSize()!.width, height: Math.ceil(size.y + size.height) + 24 });
  await scope.screenshot({ path });
};

// Measure next reply and Captures are retired: no surface offers them at any width or destination.
test('Live and History offer no Measure next reply or Captures across navigation and page/rail resizing', async ({ page }) => {
  await page.setViewportSize({ width: 1160, height: 1000 });
  await page.goto('/v2?surface=page&state=decode&chat=local');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#rate')).toHaveText('26.4');
  const retired = frame.getByRole('button', { name: /Measure next reply|Captures|Timed recording|Save to Captures/ });
  await expect(retired).toHaveCount(0);
  await expect(frame.locator('#reply-strip')).not.toContainText('Next reply');
  await page.setViewportSize({ width: 430, height: 1000 });
  await expect(retired).toHaveCount(0);
  await toHistory(frame);
  await expect(frame.locator('#view-history')).toBeVisible();
  await expect(retired).toHaveCount(0);
  await expect(frame.locator('#capture-activity, #panel-captures, .capture-card, [data-next], [data-window]')).toHaveCount(0);
  await page.setViewportSize({ width: 1160, height: 1000 });
  await expect(frame.locator('#view-history')).toBeVisible();
  await toColumn(frame);
  await expect(frame.locator('#rate')).toBeVisible();
  await expect(retired).toHaveCount(0);
});

test('design preview uses real views with isolated synthetic data and live theme controls', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewportSize({ width: 1487, height: 1170 });
  await page.clock.install({ time: Date.UTC(2026, 9, 3, 1, 0) });
  await page.addInitScript(() => {
    if (window !== window.top) return;
    addEventListener('message', event => {
      const child = document.querySelector('iframe')?.contentWindow;
      if (event.source === child && event.data === 'design-ping') child!.postMessage('design-pong', '*');
    });
  });
  await page.goto('/v2?demo=1');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#rate')).toBeVisible();
  await advance(page, 92_000);
  await expect(frame.locator('#signal .trace')).toHaveAttribute('d', /M.*L/);
  const evidence = process.env.SCOPE_EVIDENCE_DIR;
  if (evidence && testInfo.project.name === 'chromium') {
    await mkdir(evidence, { recursive: true });
    await screenshot(page, join(evidence, 'mlx-scope-dark.png'));
  }
  await toHistory(frame);
  await expect(frame.locator('.history-trend .plot')).toBeVisible();
  await expect(frame.locator('.recent-replies .led-row').first()).toBeVisible();
  if (evidence && testInfo.project.name === 'chromium')
    await screenshot(page, join(evidence, 'mlx-scope-history-dark.png'));
  await toColumn(frame);
  await page.getByRole('combobox', { name: 'Preview theme' }).selectOption('warm-amber');
  await expect(frame.locator('html')).toHaveAttribute('data-oc-theme', 'light');
  await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(248, 245, 238)');
  if (evidence && testInfo.project.name === 'chromium')
    await screenshot(page, join(evidence, 'mlx-scope-light.png'));
  await page.getByRole('link', { name: '430px panel' }).click();
  await expect(frame.locator('#scope')).toHaveAttribute('data-layout', 'column');
  await expect(frame.locator('html')).toHaveAttribute('data-oc-theme', 'light');
  await advance(page, 92_000);
  if (evidence && testInfo.project.name === 'chromium')
    await screenshot(page, join(evidence, 'mlx-scope-rail.png'));
  expect(errors).toEqual([]);
});

test('the Session widget uses native rows and keeps detail in the full panel across theme changes', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 700, height: 600 });
  await page.goto('/v2?demo=1&surface=status&theme=obsidian');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.ws-phase')).toHaveText('Idle');
  await expect(frame.locator('#ws')).toHaveAttribute('data-presentation', 'session');
  await expect(frame.locator('#ws')).toHaveAttribute('data-mode', 'summary');
  await expect(frame.getByRole('button', { name: 'Show turn stats', exact: true })).toHaveCount(0);
  await expect(frame.locator('.ws-model')).toHaveCount(0);
  await expect(frame.locator('.ws-warning')).toContainText('Memory pressure');
  await expect(frame.locator('.ws-warning')).toHaveText('Memory pressure · warning');
  await expect(frame.locator('.chip, .ts-rows, .ws-key-stats, .ws-spark')).toHaveCount(0);
  await expect(frame.locator('.speed-row')).toHaveCount(0);
  await expect(frame.getByRole('combobox', { name: 'Measurement scope' })).toHaveValue('chat');
  const visibleRows = await frame.locator('#ws .ws-line').count();
  expect(visibleRows).toBeLessThanOrEqual(3);
  await expect(frame.locator('html')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(frame.locator('body')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const evidence = process.env.SCOPE_EVIDENCE_DIR;
  if (evidence && testInfo.project.name === 'chromium') {
    await mkdir(evidence, { recursive: true });
    await page.locator('.preview-session').screenshot({ path: join(evidence, 'mlx-scope-session-dark.png') });
  }
  await frame.getByRole('button', { name: 'Open MLX Scope', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).previewOpenedSurfaces)).toEqual(['plugin:mlx-scope']);
  await page.getByRole('combobox', { name: 'Preview theme' }).selectOption('warm-amber');
  await expect(frame.locator('html')).toHaveAttribute('data-oc-theme', 'light');
  await expect(frame.locator('#ws')).toHaveAttribute('data-mode', 'summary');
  await expect(frame.locator('.ws-phase')).toHaveText('Idle');
  if (evidence && testInfo.project.name === 'chromium')
    await page.locator('.preview-session').screenshot({ path: join(evidence, 'mlx-scope-session-light.png') });
});

test('current first-token timing comes only from the current request capability', async ({ page }) => {
  await page.goto('/v2?state=decode');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#first-token')).toHaveCount(0);
  await page.evaluate(() => {
    const preview = window as any;
    const body = preview.ScopeStates.mockBody('decode', { now: Date.now() });
    body.runtime.request.ttftMs = 850;
    body.capabilities['request.ttft'] = { scope: 'request', basis: 'reported' };
    preview.setPreviewPatch({ runtime: body.runtime, capabilities: body.capabilities });
  });
  await expect(frame.locator('#first-token')).toContainText('0.85 s');
  await expect(frame.locator('#first-token [data-basis="reported"]')).toBeVisible();
  await expect(frame.locator('#engine-facts')).toBeVisible();
  await expect(frame.locator('#request-details')).toHaveJSProperty('open', false);
  await expect(frame.locator('#metrics')).toBeHidden();
  if (!(await frame.locator('#measurement-details').evaluate(el => (el as HTMLDetailsElement).open))) await frame.locator('#measurement-details > summary').click();
  await frame.locator('#request-details > summary').click();
  await expect(frame.locator('#first-token [data-basis="reported"]')).toBeVisible();
  await expect(frame.locator('#context-headroom')).toBeVisible();
  await page.evaluate(() => {
    const preview = window as any;
    const body = preview.ScopeStates.mockBody('decode', { now: Date.now() });
    // A raw field without declared support must never be promoted into the current reading.
    body.runtime.request.ttftMs = 850;
    preview.setPreviewPatch({ runtime: body.runtime, capabilities: body.capabilities });
  });
  await expect(frame.locator('#first-token')).toHaveCount(0);
});

test('the 280 px Session summary keeps one readable reading without repeating a long host model name', async ({ page }) => {
  await page.setViewportSize({ width: 300, height: 600 });
  await page.goto('/v2?state=decode&surface=status');
  await page.evaluate(() => {
    const preview = window as any;
    const body = preview.ScopeStates.mockBody('decode', { now: Date.now() });
    body.runtime.request.model = 'example-org/a-very-long-model-name-with-extra-training-and-quantization-details-27B-4bit';
    body.runtime.request.ttftMs = 850;
    body.capabilities['request.ttft'] = { scope: 'request', basis: 'reported' };
    preview.setPreviewPatch({ runtime: body.runtime, capabilities: body.capabilities });
  });
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.ws-model')).toHaveCount(0);
  await expect(frame.locator('#ws')).not.toContainText('a-very-long-model-name');
  await expect(frame.locator('.ws-phase')).toHaveText('Generating');
  await expect(frame.locator('.ws-reading')).toContainText('26.4');
  await expect(frame.locator('.ws-key-stats, .ts-rows')).toHaveCount(0);
  // The quiet Session shows the phase and one reading; first-token and output facts stay in the full panel.
  await expect(frame.locator('.ws-support, .ws-signal, .ws-plot')).toHaveCount(0);
  await expect(frame.locator('#ws')).not.toContainText('First token');
  await expect(frame.locator('#ws-notice')).toBeHidden();
  await expect(frame.locator('#ws')).not.toContainText('Context used');
  await expect(frame.getByRole('button', { name: 'Open MLX Scope', exact: true })).toBeVisible();
  const fit = await frame.locator('#ws').evaluate(el => ({ height: el.getBoundingClientRect().height,
    contentHeight: el.scrollHeight, clientHeight: el.clientHeight, pageWidth: document.documentElement.scrollWidth, availableWidth: innerWidth }));
  expect(fit.height).toBeLessThanOrEqual(320);
  expect(fit.contentHeight).toBeLessThanOrEqual(fit.clientHeight);
  expect(fit.pageWidth).toBeLessThanOrEqual(fit.availableWidth);
});

test('a remembered stats expansion cannot promote an unmeasured reply above current activity and memory pressure', async ({ page }) => {
  await page.addInitScript(() => {
    if (window === window.top) sessionStorage.setItem('pref.v2', JSON.stringify({ statusExpanded: true, tipDismissed: true, noticeDismissed: true }));
  });
  await page.setViewportSize({ width: 300, height: 600 });
  await page.goto('/v2?surface=status&state=idle');
  await page.evaluate(() => {
    const preview = window as any, now = Date.now();
    const body = preview.ScopeStates.mockBody('pressure', { now });
    body.runtime.phase = 'idle'; body.runtime.request = null; body.runtime.server.active = 0;
    body.completions = { ...body.completions, cursor: 99, reset: true, items: [{ seq: 99, startedAt: now - 125_000,
      finishedAt: now - 120_000, model: 'Example-27B-4bit', basis: 'reported', overlapped: false, host: {} }] };
    preview.setPreviewPatch({ runtime: body.runtime, completions: body.completions, alerts: body.alerts, host: body.host });
  });
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.ws-warning')).toHaveText('Memory pressure · warning');
  await expect(frame.locator('#ws')).toHaveAttribute('data-mode', 'summary');
  await expect(frame.locator('.ws-phase')).toHaveText('Idle');
  await expect(frame.locator('.ws-reading:visible, .ws-age, .ts-head, .ts-rows, .chip')).toHaveCount(0);
  await expect(frame.locator('#ws')).not.toContainText('Last reply');
  await expect(frame.locator('#ws')).not.toContainText('no turn summary');
  await expect(frame.locator('#ws')).not.toContainText('not observed');
  const fit = await frame.locator('#ws').evaluate(el => ({ contentHeight: el.scrollHeight, clientHeight: el.clientHeight,
    pageWidth: document.documentElement.scrollWidth, availableWidth: innerWidth }));
  expect(fit.contentHeight).toBeLessThanOrEqual(fit.clientHeight);
  expect(fit.pageWidth).toBeLessThanOrEqual(fit.availableWidth);
});

test('Session summary clears live speed when Splash readings become stale and restores it on fresh readings', async ({ page }) => {
  await page.goto('/v2?surface=status&state=splash-decode');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.ws-reading')).toContainText('43.8');
  await page.evaluate(() => (window as any).setPreviewState('splash-stale'));
  await expect(frame.locator('.ws-reading')).toBeHidden();
  await expect(frame.locator('#ws')).not.toContainText('tok/s');
  await expect(frame.locator('.ws-phase')).not.toHaveText('Generating');
  await page.evaluate(() => (window as any).setPreviewState('splash-decode'));
  await expect(frame.locator('.ws-reading')).toContainText('43.8');
  await expect(frame.locator('.ws-measurement .ws-label')).toHaveText('Engine');
});

test('completed-response first token remains explicitly last reply during a later request', async ({ page }) => {
  await page.goto('/v2?state=bionic');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#reply-strip')).toContainText('Last reply');
  await expect(frame.locator('#reply-strip')).toContainText('0.51 s');
  await expect(frame.locator('#engine-facts #first-token')).toHaveCount(0);
  await expect(frame.locator('#completed-facts .engine-facts-heading')).toHaveText('Last reply · Engine');
  await expect(frame.locator('#completed-facts #first-token')).toContainText('0.51 s');
  await expect(frame.locator('.instrument-primary')).toHaveAttribute('data-live', 'false');
  await page.evaluate(() => {
    const preview = window as any;
    const body = preview.ScopeStates.mockBody('bionic', { now: Date.now() });
    body.runtime.phase = 'decode'; body.runtime.server.active = 1;
    preview.setPreviewPatch({ runtime: body.runtime });
  });
  await expect(frame.locator('#phase')).toHaveText('Generating');
  await expect(frame.locator('#reply-strip')).toContainText('Last reply');
  await expect(frame.locator('#reply-strip')).toContainText('0.51 s');
  await expect(frame.locator('#completed-facts')).toHaveCount(0);
  await expect(frame.locator('#first-token')).toHaveCount(0);
  await expect(frame.locator('.speed-pair')).not.toContainText('0.51 s');
});
