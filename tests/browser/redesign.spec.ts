import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

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

// One controller owns the measurement across destinations and surface sizes.
test('next reply stays usable across navigation and page/rail resizing', async ({ page }) => {
  await page.setViewportSize({ width: 1160, height: 1000 });
  await page.goto('/v2?surface=page&state=decode&chat=local');
  const frame = page.frameLocator('iframe');
  const action = frame.getByRole('button', { name: 'Measure next reply', exact: true });
  await expect(action).toHaveCount(1);
  await action.click();
  await expect(frame.locator('#reply-strip')).toContainText('Next reply');
  await page.setViewportSize({ width: 430, height: 1000 });
  await expect(frame.locator('#reply-strip')).toContainText('Next reply');
  await frame.getByRole('tab', { name: 'History', exact: true }).click();
  await frame.getByRole('button', { name: 'Captures', exact: true }).click();
  await expect(frame.locator('[data-next="armed"]')).toBeVisible();
  await expect(frame.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(1);
  await page.setViewportSize({ width: 1160, height: 1000 });
  await expect(frame.locator('[data-next="armed"]')).toBeVisible();
  await frame.getByRole('button', { name: 'Back to History', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(1);
  await frame.getByRole('button', { name: 'Cancel', exact: true }).click();
  await frame.getByRole('tab', { name: 'Live', exact: true }).click();
  await expect(action).toHaveCount(1);
});

test('a timed capture records while Live is visible and returns with its result', async ({ page }) => {
  await page.clock.install({ time: Date.UTC(2026, 9, 3, 1, 0) });
  await page.goto('/v2?demo=1&state=decode&surface=page');
  await page.evaluate(() => {
    addEventListener('message', event => {
      const child = document.querySelector('iframe')?.contentWindow;
      if (event.source === child && event.data === 'design-ping') child!.postMessage('design-pong', '*');
    });
  });
  const frame = page.frameLocator('iframe');
  await frame.getByRole('tab', { name: 'History', exact: true }).click();
  await frame.getByRole('button', { name: 'Captures', exact: true }).click();
  await frame.getByRole('button', { name: 'Timed recording', exact: true }).click();
  await frame.getByLabel('Recording length').selectOption('30000');
  await frame.getByRole('button', { name: 'Start capture', exact: true }).click();
  await expect(frame.locator('[data-window="recording"]')).toBeVisible();
  await frame.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(frame.locator('[data-window="recording"]')).toBeVisible();
  await expect(frame.locator('[data-window] button[data-action="window-stop"]')).toBeVisible();
  await frame.getByRole('tab', { name: 'Live', exact: true }).click();
  await expect(frame.locator('#capture-activity')).toContainText('Timed recording');
  await expect(frame.locator('#capture-activity').getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await advance(page, 31_000);
  await frame.getByRole('tab', { name: 'History', exact: true }).click();
  await frame.getByRole('button', { name: 'Captures', exact: true }).click();
  await expect(frame.locator('#panel-captures .capture-ready')).toContainText('Timed recording: Captured · 30 s.');
  await frame.getByRole('button', { name: 'View timed recording', exact: true }).click();
  await expect(frame.locator('[data-window="finished"]')).toBeVisible();
  await expect(frame.locator('[data-window]')).toContainText('Captured · 30 s');
  await expect(frame.locator('[data-window]')).toContainText('tok/s');
  await frame.locator('[data-window]').getByRole('button', { name: 'Save to Captures', exact: true }).click();
  await expect(frame.getByText('Saved to Captures without model names.')).toBeVisible();
});

test('a timed capture can be cancelled from Live without losing its partial observation', async ({ page }) => {
  await page.clock.install({ time: Date.UTC(2026, 9, 3, 1, 0) });
  await page.goto('/v2?demo=1&state=decode');
  await page.evaluate(() => {
    addEventListener('message', event => {
      const child = document.querySelector('iframe')?.contentWindow;
      if (event.source === child && event.data === 'design-ping') child!.postMessage('design-pong', '*');
    });
  });
  const frame = page.frameLocator('iframe');
  await frame.getByRole('tab', { name: 'History', exact: true }).click();
  await frame.getByRole('button', { name: 'Captures', exact: true }).click();
  await frame.getByRole('button', { name: 'Timed recording', exact: true }).click();
  await frame.getByRole('button', { name: 'Start capture', exact: true }).click();
  await advance(page, 5_000);
  await frame.getByRole('tab', { name: 'Live', exact: true }).click();
  await frame.locator('#capture-activity').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(frame.locator('#capture-activity')).toBeHidden();
  await frame.getByRole('tab', { name: 'History', exact: true }).click();
  await frame.getByRole('button', { name: 'Captures', exact: true }).click();
  await expect(frame.locator('[data-window="interrupted"]')).toBeVisible();
  await expect(frame.locator('[data-window]')).toContainText('Stopped by you');
  await expect(frame.locator('[data-window]')).toContainText('tok/s');
});

test('saving a measured reply from Live refreshes the existing Captures view', async ({ page }) => {
  await page.clock.install({ time: Date.UTC(2026, 9, 3, 1, 0) });
  await page.goto('/v2?state=decode&chat=local');
  await page.evaluate(() => {
    addEventListener('message', event => {
      const child = document.querySelector('iframe')?.contentWindow;
      if (event.source === child && event.data === 'design-ping') child!.postMessage('design-pong', '*');
    });
    (window as any).setPreviewSession({ id: 'fixture-chat', title: 'Fixture chat', busy: false, model: 'omlx/Example-27B-4bit' });
  });
  const frame = page.frameLocator('iframe');
  // Mount the destination before saving elsewhere, exercising activation of an existing controller.
  await frame.getByRole('tab', { name: 'History', exact: true }).click();
  await frame.getByRole('button', { name: 'Captures', exact: true }).click();
  await expect(frame.locator('#panel-captures .ledger')).toHaveCount(0);
  await frame.getByRole('tab', { name: 'Live', exact: true }).click();
  await frame.getByRole('button', { name: 'Measure next reply', exact: true }).click();
  await page.evaluate(() => { (window as any).sendPreviewLifecycle('started'); });
  await advance(page, 2_000);
  await expect(frame.locator('#reply-strip')).toContainText('Measuring next reply');
  await page.evaluate(() => {
    const preview = window as any, now = Date.now();
    const body = preview.ScopeStates.mockBody('decode', { now });
    body.completions.cursor = 58;
    body.completions.items = [{ seq: 58, startedAt: now - 2_000, finishedAt: now, model: 'Example-27B-4bit', basis: 'last-observed',
      decodeTps: 25, outputTokens: 50, overlapped: false, host: {} }];
    preview.setPreviewPatch({ completions: body.completions });
    preview.sendPreviewLifecycle('completed');
  });
  await advance(page, 3_000);
  await frame.getByRole('button', { name: 'Save to Captures', exact: true }).click();
  await expect(frame.locator('#action-status')).toContainText('Saved');
  await frame.getByRole('tab', { name: 'History', exact: true }).click();
  await frame.getByRole('button', { name: 'Captures', exact: true }).click();
  await expect(frame.locator('#panel-captures .ledger .led-row')).toHaveCount(1);
  await expect(frame.locator('#panel-captures .ledger')).toContainText('25.0 tok/s');
  await expect(frame.locator('#panel-captures .ledger')).toContainText('Next reply · oMLX');
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
  await frame.getByRole('tab', { name: 'History', exact: true }).click();
  await expect(frame.locator('.history-trend .plot')).toBeVisible();
  await expect(frame.locator('.recent-replies .led-row').first()).toBeVisible();
  if (evidence && testInfo.project.name === 'chromium')
    await screenshot(page, join(evidence, 'mlx-scope-history-dark.png'));
  await frame.getByRole('tab', { name: 'Live', exact: true }).click();
  await page.getByRole('combobox', { name: 'Preview theme' }).selectOption('warm-amber');
  await expect(frame.locator('html')).toHaveAttribute('data-oc-theme', 'light');
  await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(248, 245, 238)');
  if (evidence && testInfo.project.name === 'chromium')
    await screenshot(page, join(evidence, 'mlx-scope-light.png'));
  await page.getByRole('link', { name: '430px panel' }).click();
  await expect(frame.locator('#scope')).toHaveAttribute('data-layout', 'tabs');
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
  await expect(frame.locator('.ws-model')).toBeVisible();
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
  await expect(frame.locator('#request-details')).toHaveJSProperty('open', false);
  await expect(frame.locator('#metrics')).toBeHidden();
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

test('the 280 px Session summary keeps performance readable and preserves a long model name', async ({ page }) => {
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
  await expect(frame.locator('.ws-model')).toContainText('a-very-long-model-name');
  await expect(frame.locator('.ws-model')).toHaveAttribute('title', 'example-org/a-very-long-model-name-with-extra-training-and-quantization-details-27B-4bit');
  await expect(frame.locator('.ws-phase')).toHaveText('Generating');
  await expect(frame.locator('.ws-reading')).toContainText('26.4');
  await expect(frame.locator('.ws-key-stats, .ts-rows')).toHaveCount(0);
  await expect(frame.locator('#ws')).not.toContainText('First token');
  await expect(frame.locator('#ws')).not.toContainText('Context used');
  await expect(frame.getByRole('button', { name: 'Open MLX Scope', exact: true })).toBeVisible();
  const fit = await frame.locator('#ws').evaluate(el => ({ height: el.getBoundingClientRect().height,
    contentHeight: el.scrollHeight, clientHeight: el.clientHeight, pageWidth: document.documentElement.scrollWidth, availableWidth: innerWidth }));
  expect(fit.height).toBeLessThanOrEqual(200);
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
  await expect(frame.locator('.ws-reading, .ws-age, .ts-head, .ts-rows, .chip')).toHaveCount(0);
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
  await expect(frame.locator('.ws-reading')).toHaveCount(0);
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
  await expect(frame.locator('#first-token')).toHaveCount(0);
  await page.evaluate(() => {
    const preview = window as any;
    const body = preview.ScopeStates.mockBody('bionic', { now: Date.now() });
    body.runtime.phase = 'decode'; body.runtime.server.active = 1;
    preview.setPreviewPatch({ runtime: body.runtime });
  });
  await expect(frame.locator('#phase')).toHaveText('Generating');
  await expect(frame.locator('#reply-strip')).toContainText('Last reply');
  await expect(frame.locator('#reply-strip')).toContainText('0.51 s');
  await expect(frame.locator('#first-token')).toHaveCount(0);
  await expect(frame.locator('.speed-pair')).not.toContainText('0.51 s');
});
