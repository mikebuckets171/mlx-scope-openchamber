import { expect, test, type FrameLocator } from '@playwright/test';

// A section's heading and controls remain legible when OpenChamber enlarges text. Content may wrap vertically;
// nothing is squeezed into a fixed-height row or pushed beyond the surface's horizontal bounds.
const readable = async (frame: FrameLocator, selector: string) => {
  const region = frame.locator(selector);
  expect(await region.evaluate(root => {
    const visible = (node: Element) => node.checkVisibility() && !node.closest('details:not([open])');
    const problems: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) problems.push('horizontal overflow');
    for (const heading of Array.from(root.querySelectorAll('h2, h3, h4'))) {
      if (!visible(heading)) continue;
      const note = heading.closest('section, .media-view, .media-job')?.querySelector('.insight-note, .coverage-note, .media-meta');
      if (note && visible(note) && parseFloat(getComputedStyle(heading).fontSize) < parseFloat(getComputedStyle(note).fontSize))
        problems.push(`${heading.textContent} is smaller than its explanation`);
    }
    for (const control of Array.from(root.querySelectorAll('button, select, summary'))) {
      const closed = control.closest('details:not([open])');
      if (!control.checkVisibility() || closed && closed.querySelector(':scope > summary') !== control) continue;
      const rect = control.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 24) problems.push(`${control.textContent?.trim()} has a small target`);
      if (control.scrollHeight > control.clientHeight + 1 || control.scrollWidth > control.clientWidth + 1)
        problems.push(`${control.textContent?.trim()} clips its label`);
    }
    return problems;
  })).toEqual([]);
};

// Entering a secondary view starts at its title and return action, even after leaving a long, enlarged Live view.
const secondaryEntry = async (frame: FrameLocator, view: string, titleFocused = true) => {
  if (titleFocused) await expect(frame.locator(`#${view}-title`)).toBeFocused();
  const bounds = () => frame.locator(`#panel-${view} > .secondary-heading`).evaluate(root =>
    [root, ...Array.from(root.querySelectorAll('h2, button'))].map(node => {
      const rect = node.getBoundingClientRect();
      return { text: node.textContent?.trim(), top: rect.top, bottom: rect.bottom, fits: rect.top >= -1 && rect.bottom <= innerHeight + 1 };
    }));
  const initial = await bounds();
  await expect.poll(async () => (await bounds()).filter(rect => !rect.fits), `${view} heading bounds: ${JSON.stringify(initial)}`).toEqual([]);
};

// At double text size a poll can move a control between the moment a pointer click picks it and the moment the
// click lands. Activating the focused control keeps this test about legibility and focus, not pointer timing.
const activate = async (frame: FrameLocator, name: string) => {
  const control = frame.getByRole('button', { name, exact: true });
  await control.scrollIntoViewIfNeeded();
  await control.focus();
  await expect(control).toBeFocused();
  await control.press('Enter');
};

for (const theme of ['light', 'dark']) for (const [width, font] of [[320, 32], [430, 24], [1160, 16]] as const) {
  test(`shared hierarchy and controls remain readable at ${width}px/${font}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.goto(`/v2?surface=page&state=decode&media=active&theme=${theme}`);
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('#rate')).toBeVisible();
    await frame.locator('html').evaluate((node, size) => { node.style.fontSize = `${size}px`; }, font);
    await readable(frame, '#scope');
    const media = frame.locator('.media-progress-copy');
    await expect(media).toContainText('Sampling');
    // A phase label needs a usable column beside its ring; action controls wrap to the next line first.
    expect(await media.evaluate(node => node.getBoundingClientRect().width / parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThan(5);
    await frame.locator('#measurement-details > summary').click();
    await frame.locator('#engine-readings > summary').click();
    await readable(frame, '#scope');
    await activate(frame, 'Run details');
    await expect(frame.getByRole('heading', { name: 'Current observation', exact: true })).toBeFocused();
    await secondaryEntry(frame, 'history', false);
    await readable(frame, '.run-detail');
    await frame.locator('#panel-history > .secondary-heading').getByRole('button', { name: 'Back', exact: true }).click();
    await expect(frame.getByRole('button', { name: 'Run details', exact: true })).toBeFocused();
    await activate(frame, 'Server & Mac details');
    await secondaryEntry(frame, 'server');
    await readable(frame, '#panel-server');
    await frame.getByRole('button', { name: 'Back', exact: true }).click();
    await activate(frame, 'History');
    await secondaryEntry(frame, 'history');
    const historyList = frame.locator('#view-history > .view-host > :first-child');
    await expect(historyList).toHaveCSS('margin-top', '0px');
    expect(await historyList.evaluate(node => node.getBoundingClientRect().top - node.parentElement!.getBoundingClientRect().top)).toBe(0);
    await frame.locator('.history-insights > summary').click();
    await frame.locator('.history-storage > summary').click();
    await expect(frame.getByRole('checkbox', { name: 'Label replies to this chat automatically' })).toBeVisible();
    await readable(frame, '#view-history');
    await activate(frame, 'Connections');
    await frame.locator('#runtime-connection-details > summary').click();
    await frame.locator('#connection-help > summary').click();
    await readable(frame, '#connection-setup');
    const close = frame.getByRole('button', { name: 'Close connections', exact: true });
    await close.focus(); await expect(close).toBeFocused();
    await close.press('Escape');
    await expect(frame.locator('#connection-setup')).toBeHidden();
    await expect(frame.getByRole('button', { name: 'Connections', exact: true })).toBeFocused();
  });
}

for (const width of [320, 1160]) test(`same-state updates retain content geometry, focus and disclosure state at ${width}px`, async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width, height: 950 });
  await page.goto('/v2?surface=page&state=decode&poll=500');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#rate')).toHaveText('26.4');
  await frame.locator('html').evaluate(node => { node.style.fontSize = '32px'; });
  // The second sample introduces a genuine trend section. Start the stability check after that arrival.
  await page.clock.runFor(600);
  await expect(frame.locator('#engine-trend')).toBeVisible();
  await frame.locator('#measurement-details > summary').click();
  await frame.locator('#engine-readings > summary').click();
  const help = frame.locator('.instrument-source .info');
  await help.click(); await help.focus();
  const bounds = () => frame.locator('#hero').evaluate(root => Array.from(root.querySelectorAll('.instrument-readout, #measurement-details > summary, #engine-readings > summary')).map(node => {
    const rect = node.getBoundingClientRect(); return { y: rect.y, height: rect.height, width: rect.width };
  }));
  const before = await bounds();
  await page.evaluate(() => {
    const fixture = window as any, runtime = fixture.ScopeStates.mockBody('decode', { now: Date.now() }).runtime;
    fixture.setPreviewPatch({ runtime: { ...runtime, request: { ...runtime.request, decodeTps: 27.5 } } });
  });
  await page.clock.runFor(600);
  await expect(frame.locator('#rate')).toHaveText('27.5');
  expect(await bounds()).toEqual(before);
  await expect(help).toBeFocused();
  await expect(help).toHaveAttribute('aria-expanded', 'true');
  for (const id of ['measurement-details', 'engine-readings']) await expect(frame.locator(`#${id}`)).toHaveAttribute('open', '');
});

for (const width of [320, 1160]) test(`run comparison separates the metric group from its values at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 950 });
  await page.goto(`/history.html?state=decode${width > 900 ? '&surface=page' : ''}`);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await page.locator('html').evaluate((node, size) => { node.style.fontSize = `${size}px`; }, width === 320 ? 32 : 16);
  await page.locator('.ledger [data-action="inspect"]').nth(1).click();
  const select = page.getByLabel('Compare with'), option = await select.locator('option').nth(1).getAttribute('value');
  await select.selectOption(option!);
  const basis = page.locator('.run-comparison dd > .basis').first();
  await expect(basis).toHaveCSS('display', 'block');
  expect(await basis.evaluate(node => {
    const previous = node.previousSibling!, range = document.createRange(); range.selectNodeContents(previous);
    const label = node.getBoundingClientRect(), values = range.getBoundingClientRect();
    return label.height > 0 && label.top >= values.bottom;
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});


test('the first engine trace preserves the focused details control and its DOM identity', async ({ page }) => {
  await page.goto('/v2?surface=page&state=decode');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#rate')).toBeVisible();
  await frame.locator('#measurement-details > summary').click();
  const control = frame.getByRole('button', { name: 'Run details', exact: true });
  await control.focus();
  await control.evaluate(node => { (node as any).scopeIdentity = 'initial-detail-control'; });
  await expect(frame.locator('#engine-trend')).toBeVisible();
  await expect(control).toBeFocused();
  expect(await control.evaluate(node => (node as any).scopeIdentity)).toBe('initial-detail-control');
  await control.press('Enter');
  await expect(frame.getByRole('heading', { name: 'Current observation', exact: true })).toBeFocused();
});
