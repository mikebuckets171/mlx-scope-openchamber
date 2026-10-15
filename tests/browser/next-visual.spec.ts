import { expect, test } from '@playwright/test';
import { inspect } from './ui-checks.ts';

// Real render checks over both engines. No pixel baselines from a synthetic design image.
for (const width of [320, 430, 652, 1160]) for (const theme of ['light', 'dark']) {
  test(`Next readable at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?sdk=next&surface=page&design=next&state=decode&chat=1&theme=${theme}`);
    const frame = page.frames().find(f => f !== page.mainFrame())!;
    await expect(frame.locator('html')).toHaveAttribute('data-design-mode', 'next');
    await expect(frame.locator('#hero')).toBeVisible();
    await expect(frame.locator('.next-nav [data-action="show-live"]')).toHaveAttribute('aria-current', 'page');
    await expect(frame.locator('#engine-facts')).toContainText('Output');
    expect(await frame.evaluate(inspect, false)).toEqual([]);
    const instrument = await frame.locator('#hero').boundingBox();
    const machine = await frame.locator('#machine').boundingBox();
    expect(instrument).not.toBeNull(); expect(machine).not.toBeNull();
    // Precision is one continuous instrument at every width; host readings form the compact band below it.
    expect(machine!.y).toBeGreaterThanOrEqual(instrument!.y + instrument!.height);
    expect(Math.abs(machine!.x - instrument!.x)).toBeLessThan(2);
    await expect(frame.locator('#engine-trend')).toBeVisible();
    const reading = await frame.locator('#hero .instrument-measure').boundingBox();
    const trace = await frame.locator('#engine-trend').boundingBox();
    const facts = await frame.locator('#engine-facts').boundingBox();
    expect(reading).not.toBeNull(); expect(trace).not.toBeNull(); expect(facts).not.toBeNull();
    expect(trace!.y).toBeGreaterThanOrEqual(reading!.y + reading!.height);
    expect(facts!.y).toBeGreaterThanOrEqual(trace!.y + trace!.height);
    if (width === 652) {
      const size = await frame.locator('#hero .instrument-primary .speed-value > strong').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
      expect(size).toBeGreaterThanOrEqual(100); expect(size).toBeLessThanOrEqual(120);
    }
    await expect(frame.locator('.column-foot')).toBeHidden();
    await frame.locator('#measurement-details > summary').click();
    await expect(frame.locator('.precision-detail-actions [data-action="open-run"]')).toBeVisible();
    await frame.locator('.precision-detail-actions [data-action="open-server"]').click();
    await expect(frame.locator('#panel-server')).toBeVisible();
    await frame.locator('.next-nav [data-action="show-live"]').click();
    await frame.locator('.next-nav [data-action="open-history"]').click();
    await expect(frame.locator('#panel-history')).toBeVisible();
    expect(await frame.evaluate(inspect, false)).toEqual([]);
    await frame.getByRole('button', { name: 'Captures', exact: true }).click();
    await expect(frame.locator('#panel-captures')).toBeVisible();
    expect(await frame.evaluate(inspect, false)).toEqual([]);
    await expect(frame.locator('.next-nav [data-action="open-history"]')).toHaveAttribute('aria-current', 'page');
    await frame.locator('.next-nav [data-action="show-live"]').click();
    await expect(frame.locator('#hero')).toBeVisible();
    await frame.locator('.next-nav [data-action="connection"]').click();
    await expect(frame.locator('#connection-setup')).toBeVisible();
    expect(await frame.evaluate(inspect, false)).toEqual([]);
    await expect(frame.locator('.next-nav [data-action="connection"]')).toHaveAttribute('aria-current', 'page');
    await expect(frame.locator('.next-nav [data-action="open-history"]')).not.toHaveAttribute('aria-current', 'page');
    await frame.locator('.next-nav [data-action="show-live"]').click();
    await expect(frame.locator('#connection-setup')).toBeHidden();
  });
}

test('Next continuous instrument keeps its natural column with enlarged text', async ({ page }) => {
  await page.setViewportSize({ width: 1160, height: 900 });
  await page.goto('/?sdk=next&surface=page&design=next&state=decode&chat=1');
  const frame = page.frames().find(f => f !== page.mainFrame())!;
  await expect(frame.locator('#machine')).toBeVisible();
  await frame.addStyleTag({ content: ':root { font-size: 24px !important; }' });
  const instrument = await frame.locator('#hero').boundingBox(), machine = await frame.locator('#machine').boundingBox();
  expect(machine!.y).toBeGreaterThanOrEqual(instrument!.y + instrument!.height);
  expect(await frame.evaluate(inspect, false)).toEqual([]);
});

test('long model names and warnings fit narrow views through enlarged text', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 1000 });
  await page.goto('/v2?surface=page&state=splash-long-warning&media=active&theme=dark');
  const frame = page.frames().find(f => f !== page.mainFrame())!;
  await expect(frame.locator('.precision-model')).toContainText('organization/A-very-long-model-name');
  for (const size of [16, 24, 32]) {
    await frame.locator('html').evaluate((el, size) => { el.style.fontSize = `${size}px`; }, size);
    expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(frame.locator('.connection-diagnosis')).toBeVisible();
    await expect(frame.locator('.next-nav [data-action="connection"]')).toBeVisible();
    const brand = await frame.locator('.masthead .brand').boundingBox(), runtime = await frame.locator('.masthead .status-pill').boundingBox();
    expect(brand!.x + brand!.width <= runtime!.x + 1 || brand!.y + brand!.height <= runtime!.y + 1).toBe(true);
    for (const row of await frame.locator('.machine-line > div').all()) {
      const label = await row.locator(':scope > span').boundingBox(), value = await row.locator(':scope > strong').boundingBox();
      expect(label!.x + label!.width <= value!.x + 1 || label!.y + label!.height <= value!.y + 1).toBe(true);
    }
  }
});

test('Compact keeps the short rail layout with the standard design', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto('/v2?surface=panel&state=splash-decode');
  const frame = page.frames().find(f => f !== page.mainFrame())!;
  await frame.locator('#monitor-menu > summary').click();
  await frame.locator('#compact').click();
  await expect(frame.locator('#compact-glance .ws')).toBeVisible();
  expect(await frame.locator('#scope').evaluate(el => el.scrollHeight)).toBeLessThanOrEqual(200);
  expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(frame.getByRole('button', { name: 'Expand', exact: true })).toBeVisible();
});

test('Next startup trace fits only observed history and keeps its endpoint inside the plot', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 1000 });
  await page.goto('/?sdk=next&surface=page&design=next&state=decode&chat=1');
  const frame = page.frames().find(f => f !== page.mainFrame())!;
  await expect(frame.locator('#engine-trend')).toBeVisible();
  await expect(frame.locator('#signal')).toHaveAttribute('data-short', 'true');
  await expect(frame.locator('#signal figcaption > span:first-child')).not.toHaveText('−90s');
  const plot = await frame.locator('#signal .plot').boundingBox();
  const endpoint = await frame.locator('#signal .trace-endpoint').boundingBox();
  expect(endpoint!.width).toBeLessThanOrEqual(6);
  expect(endpoint!.x).toBeGreaterThanOrEqual(plot!.x - 1);
  expect(endpoint!.x + endpoint!.width).toBeLessThanOrEqual(plot!.x + plot!.width + 1);
  // A shorter observation window must not stretch an earlier turn marker outside the plot.
  expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Next paused trace keeps the received reading and identifies it as historical', async ({ page }) => {
  await page.setViewportSize({ width: 652, height: 989 });
  await page.goto('/?sdk=next&surface=page&design=next&state=decode&chat=1');
  const frame = page.frames().find(f => f !== page.mainFrame())!;
  await expect(frame.locator('#engine-trend')).toBeVisible();
  await frame.getByRole('button', { name: 'Pause monitoring', exact: true }).click();
  await expect(frame.locator('.instrument-phase')).toHaveText('Paused');
  await expect(frame.locator('#signal figcaption > span:last-child')).toHaveText('last reading');
  await expect(frame.locator('#signal .plot')).toHaveAttribute('aria-label', /last reading/);
  await frame.getByRole('button', { name: 'Resume monitoring', exact: true }).click();
  await expect(frame.locator('#signal figcaption > span:last-child')).toHaveText('now');
});

test('Next keeps focused details stable through active, idle and offline updates and enlarged text', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 1000 });
  await page.goto('/?sdk=next&surface=page&design=next&state=decode&chat=1');
  const frame = page.frames().find(f => f !== page.mainFrame())!;
  await expect(frame.locator('#hero')).toBeVisible();
  // A real text-size change exercises rem sizes rather than a screenshot scale.
  await frame.addStyleTag({ content: ':root { font-size: 24px !important; }' });
  expect(await frame.evaluate(inspect, false)).toEqual([]);
  const details = frame.locator('#measurement-details > summary');
  await details.click(); await details.focus();
  await expect(details).toBeFocused();
  await page.evaluate('window.setPreviewState("idle")');
  await expect(frame.locator('.instrument-phase')).toHaveText('Waiting');
  await expect(details).toBeFocused();
  await page.evaluate('window.setPreviewState("offline")');
  await expect(frame.locator('#phase')).toHaveText('Offline');
  expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate('window.setPreviewState("decode")');
  await expect(frame.locator('.instrument-phase')).toHaveText('Generating');
  await expect(frame.locator('#design-mode,[data-design-choice]')).toHaveCount(0);
  await expect(frame.locator('html')).toHaveAttribute('data-design-mode', 'next');
});

test('Next session stays compact at enlarged text, honors reduced motion and exposes a snapshot explanation', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/?sdk=next&surface=status&design=next&state=decode&chat=1');
  const frame = page.frames().find(f => f !== page.mainFrame())!;
  await expect(frame.locator('#ws')).toBeVisible();
  await frame.addStyleTag({ content: ':root { font-size: 24px !important; }' });
  expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await frame.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(page.frameLocator('iframe[title="Scope detail popover"]').getByRole('region', { name: 'Measurement details' })).toBeVisible();
  expect(await page.evaluate('window.previewPopoverCollectorCalls')).toEqual([]);
});
