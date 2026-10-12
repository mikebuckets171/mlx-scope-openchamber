import { expect, test, type Frame, type FrameLocator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Same fixture inventory as panel/testing/mock-states.ts; Node's test loader cannot import its bare JSON module.
const MOCK_STATES = Object.keys(JSON.parse(readFileSync(new URL('../../docs/design/2.0-mock-fixtures.json', import.meta.url), 'utf8')).states);

test.beforeEach(async ({ page }) => { await page.addInitScript(() => sessionStorage.clear()); });

// Synthetic fixture geometry only: a region has rendered content or gives back its height.
// Read the shared state list so a new runtime state automatically joins this coverage.
const geometry = () => {
  const failures: string[] = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) failures.push('content overflows the surface horizontally');
  const shown = (node: HTMLElement) => {
    if (!node.getClientRects().length || getComputedStyle(node).visibility === 'hidden') return false;
    // Closed details can retain descendant rects in the layout tree, but only their summary occupies visible space.
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.matches('details:not([open])') && !ancestor.querySelector(':scope > summary')?.contains(node)) return false;
    }
    return true;
  };
  const name = (node: HTMLElement) => node.id ? `#${node.id}` : `.${node.className.trim().replace(/\s+/g, '.')}`;
  const content = (node: HTMLElement) => node.innerText.trim().length > 0 || Array.from(node.querySelectorAll<HTMLElement>(
    'button, select, input, [role="progressbar"], .usage-bars i, svg path.trace, svg path.band, .gap-band',
  )).some(child => shown(child) && (!child.matches('svg path') || !!child.getAttribute('d')));
  const regions = '.instrument-readout, .instrument-measure, .instrument-evidence, .machine-summary-values, .machine-health, .media-glance-timing, '
    + '.media-jobs, .media-sources, .actions, .insight-actions, .metrics, .values-2, .values-3, .ledger, .usage-bars, .usage-days, '
    + '#view-live, #view-media, #view-history, #captures-content, #media-setup, #media-advanced, #companion-setup';
  for (const region of Array.from(document.querySelectorAll<HTMLElement>(regions))) {
    if (!shown(region)) continue;
    const height = region.getBoundingClientRect().height, style = getComputedStyle(region);
    const occupied = height + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
    if (!content(region) && occupied > 1) failures.push(`${name(region)} occupies ${occupied.toFixed(1)} px without content`);
    if (region.matches('.instrument-measure, .instrument-evidence') && region.dataset.quiet === 'true' && height > 1)
      failures.push(`${name(region)} is quiet but reserves ${height.toFixed(1)} px`);
    if (region.matches('.instrument-measure, .instrument-evidence')) {
      const children = Array.from(region.children).filter((node): node is HTMLElement => node instanceof HTMLElement && shown(node));
      if (children.length) {
        const first = children[0]!, last = children[children.length - 1]!;
        const natural = last.getBoundingClientRect().bottom - first.getBoundingClientRect().top
          + parseFloat(getComputedStyle(first).marginTop) + parseFloat(getComputedStyle(last).marginBottom);
        if (height > natural + 1) failures.push(`${name(region)} reserves ${(height - natural).toFixed(1)} px beyond its content`);
      }
    }
    if (region.matches('.media-setup-source > .insight-actions') && !content(region))
      failures.push('a source with no setup actions retains an empty action wrapper');
  }
  for (const activity of Array.from(document.querySelectorAll<HTMLElement>('.ws-activity'))) {
    if (!shown(activity)) continue;
    const rows = getComputedStyle(activity).gridTemplateRows.split(/\s+/).map(Number.parseFloat);
    const measurement = activity.querySelector('.ws-measurement');
    const support = activity.querySelector('.ws-support, .ws-note, .ws-warning, .ws-action-error');
    if (!measurement && (rows[1] ?? 0) > 1) failures.push(`absent glance measurement reserves ${rows[1]} px`);
    if (!support && (rows[2] ?? 0) > 1) failures.push(`absent glance support reserves ${rows[2]} px`);
  }
  for (const node of Array.from(document.querySelectorAll<HTMLElement>('#panels [hidden], #connection-setup[hidden]'))) {
    if (node.getBoundingClientRect().height > 0) failures.push(`${name(node)} is hidden but reserves height`);
  }
  return failures;
};
const clean = async (frame: Frame, context: string): Promise<void> => { expect(await frame.evaluate(geometry), context).toEqual([]); };
const load = async (page: Page, query: string, width: number, fontSize?: number): Promise<{ frame: Frame; ui: FrameLocator }> => {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`/v2?${query}&tracking=ready`);
  const ui = page.frameLocator('iframe');
  await expect(ui.locator('#scope')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).previewRequests)).toBeGreaterThan(0);
  const frame = page.mainFrame().childFrames()[0]!;
  if (fontSize) await ui.locator('html').evaluate((node, size) => { node.style.fontSize = `${size}px`; }, fontSize);
  if (query.includes('surface=status')) await expect(ui.locator('.ws-phase')).not.toHaveText('Connecting');
  else await expect(ui.locator('#phase')).not.toHaveText('Connecting');
  return { frame, ui };
};

// A finite cross-surface matrix covers every state at ordinary, enlarged and 200% text, in both themes.
const SURFACES = [
  { surface: 'page', width: 320, theme: 'dark', font: 16 },
  { surface: 'page', width: 1160, theme: 'light', font: 16 },
  { surface: 'panel', width: 430, theme: 'light', font: 24 },
  { surface: 'panel', width: 320, theme: 'dark', font: 32 },
  { surface: 'page', width: 1160, theme: 'dark', font: 32 },
] as const;
for (const { surface, width, theme, font } of SURFACES) test(`all mock states use natural content height on ${surface} at ${width}px, ${font}px text, ${theme}`, async ({ page }) => {
  test.setTimeout(240_000);
  for (const state of MOCK_STATES) await test.step(state, async () => {
    const { frame, ui } = await load(page, `surface=${surface}&state=${state}&media=active&theme=${theme}`, width, font);
    if (state === 'paused') await ui.getByRole('button', { name: 'Pause monitoring', exact: true }).click();
    await clean(frame, `${state}: page hero and media`);
    const server = ui.getByRole('button', { name: 'Server & Mac details', exact: true });
    if (await server.isVisible()) {
      await server.click();
      await expect(ui.locator('#server-title')).toBeVisible();
      await clean(frame, `${state}: server`);
      await ui.getByRole('button', { name: 'Back', exact: true }).click();
    }
    const history = ui.getByRole('button', { name: 'History', exact: true });
    if (await history.isVisible()) {
      await history.click();
      await expect(ui.locator('.history-storage')).toBeVisible();
      await clean(frame, `${state}: history`);
      await ui.getByRole('button', { name: 'Captures', exact: true }).click();
      await expect(ui.locator('.capture-card')).toBeVisible();
      await clean(frame, `${state}: captures`);
      await ui.getByRole('button', { name: 'Back to History', exact: true }).click();
      await ui.getByRole('button', { name: 'Back', exact: true }).click();
    }
    await ui.getByRole('button', { name: 'Connections', exact: true }).click();
    await expect(ui.locator('#companion-setup')).not.toBeEmpty();
    await expect(ui.locator('#media-setup')).not.toBeEmpty();
    await clean(frame, `${state}: connections`);
    await ui.getByRole('button', { name: 'Close connections', exact: true }).click();
    if (await ui.locator('#panels').isVisible()) {
      await page.setViewportSize({ width: 320, height: 1000 });
      await ui.locator('#monitor-menu > summary').click();
      await ui.locator('#compact').click();
      await expect(ui.locator('#compact-glance .ws')).toBeVisible();
      await clean(frame, `${state}: compact glance`);
    }
  });
});

for (const [theme, font] of [['dark', 16], ['light', 32]] as const) test(`every mock status glance folds absent rows in ${theme} at ${font}px without hiding notes or media`, async ({ page }) => {
  test.setTimeout(120_000);
  for (const state of MOCK_STATES) await test.step(state, async () => {
    const { frame, ui } = await load(page, `surface=status&state=${state}&media=active&theme=${theme}`, 280, font);
    await expect(ui.locator('.ws-phase')).not.toBeEmpty();
    await clean(frame, `${state}: status`);
  });
});

test('populated glance rows keep their space while offline and unmeasured rows collapse', async ({ page }) => {
  const { frame, ui } = await load(page, 'surface=status&state=decode', 500);
  for (const width of [230, 430]) {
    await page.locator('iframe').evaluate((node, width) => { (node as HTMLElement).style.width = `${width}px`; }, width);
    const heights = await ui.locator('.ws-activity').evaluate(node => {
      const measure = node.querySelector('.ws-measurement')!, support = node.querySelector('.ws-support')!;
      return [measure.getBoundingClientRect().height, support.getBoundingClientRect().height, parseFloat(getComputedStyle(document.documentElement).fontSize)];
    });
    expect(heights[0]).toBeGreaterThanOrEqual(width === 230 ? 2.625 * heights[2]! : Math.max(36, 2.25 * heights[2]!));
    expect(heights[1]).toBeGreaterThanOrEqual(width === 230 ? 2.0625 * heights[2]! : Math.max(20, 1.25 * heights[2]!));
    await clean(frame, `populated ${width}px`);
  }
  const offline = await load(page, 'surface=status&state=offline', 300);
  await expect(offline.ui.locator('.ws-note')).toContainText('Scope checks again automatically');
  await expect(offline.ui.locator('.ws-measurement')).toHaveCount(0);
  await clean(offline.frame, 'offline note');
  const unmeasured = await load(page, 'surface=status&state=splash-measuring', 300);
  await expect(unmeasured.ui.locator('.ws-measurement, .ws-support')).toHaveCount(0);
  await clean(unmeasured.frame, 'unmeasured Splash');
});

for (const width of [320, 1160]) test(`media empty states and connections use natural content height at ${width}px`, async ({ page }) => {
  for (const state of ['none', 'empty', 'disconnected', 'completed', 'failed', 'cancelled']) {
    const { frame, ui } = await load(page, `surface=page&state=idle&media=${state}`, width);
    await expect.poll(() => page.evaluate(() => (window as any).previewAuxiliaryRequests.some((request: any) => request.path === '/v2/media'))).toBe(true);
    if (['completed', 'failed', 'cancelled'].includes(state)) {
      const empty = ui.locator('.media-empty');
      await expect(empty).toContainText('No active media jobs');
      expect(await empty.evaluate(node => {
        const first = node.firstElementChild!, last = node.lastElementChild!;
        return { excess: node.getBoundingClientRect().height - (last.getBoundingClientRect().bottom - first.getBoundingClientRect().top) };
      })).toEqual({ excess: 12 });
      await ui.locator('.media-recent > summary').click();
    } else await expect(ui.locator('#view-media')).toBeHidden();
    await clean(frame, `media ${state}`);
  }
  const { frame, ui } = await load(page, 'surface=page&state=idle&setup=all-sources', width);
  await ui.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(ui.locator('.media-setup-source')).toHaveCount(2);
  await expect(ui.locator('.media-setup-source > .insight-actions')).toHaveCount(0);
  await ui.locator('#connection-help > summary').click();
  await clean(frame, 'connections without helper actions');
});

test('empty history, saved captures, and bucketless usage retain explanations and totals without empty plots', async ({ page }) => {
  for (const width of [320, 1160]) {
    const { frame, ui } = await load(page, 'surface=page&state=history-empty&leader=0', width);
    await ui.getByRole('button', { name: 'History', exact: true }).click();
    await expect(ui.locator('#view-history .recent-replies .empty')).toBeVisible();
    await expect(ui.locator('#view-history .plot')).toHaveCount(0);
    await clean(frame, 'empty history');
    await ui.getByRole('button', { name: 'Captures', exact: true }).click();
    await expect(ui.locator('#captures-content .empty')).toBeVisible();
    await expect(ui.locator('#captures-content .ledger')).toHaveCount(0);
    await clean(frame, 'empty saved captures');
    await page.goto('/history.html?surface=page&usage=totals-only');
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    await page.locator('.history-insights > summary').click();
    const usage = page.locator('.insight-section').filter({ has: page.getByRole('heading', { name: 'Recorded by oMLX', exact: true }) });
    await expect(usage).toContainText('412');
    await expect(usage.locator('.usage-bars, .usage-days')).toHaveCount(0);
    await clean(page.mainFrame(), 'reported totals without daily buckets');
  }
});
