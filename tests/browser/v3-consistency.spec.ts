import { expect, test, type FrameLocator, type Page } from '@playwright/test';

type Phase = 'generating' | 'reasoning' | 'tool' | 'waiting' | 'complete' | 'cancelled';
const setPhase = (page: Page, phase: Phase, rate?: number) => page.evaluate(({ phase, rate }) => {
  const w = window as any, now = Date.now(), complete = phase === 'complete';
  if (complete) w.setPreviewSession({ id: 'fixture-chat', busy: false, model: 'omlx/Example-27B-4bit' });
  w.setPreviewPatch({ chat: { scope: 'chat', basis: complete ? 'reported-output' : 'estimated-characters',
    timingBasis: complete ? 'completed-step' : 'delivery-window', phase, tokensPerSecond: rate,
    observedAtMs: now, expiresAtMs: now + 5_000,
    observation: { startedAtMs: now - 3_000, endedAtMs: now }, freshness: complete ? 'last' : 'live' } });
}, { phase, rate });
const position = (frame: FrameLocator, selector: string) => frame.locator(selector).evaluate(element => {
  const r = element.getBoundingClientRect(); return { y: r.y, height: r.height };
});

const glanceGeometry = (frame: FrameLocator) => frame.locator('#ws').evaluate(section => {
  const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { y: r.y, height: r.height }; };
  const activity = section.querySelector('.ws-scroll')!, measurement = section.querySelector('.ws-measurement:not([hidden])');
  const support = section.querySelector('.ws-support:not([hidden]), .ws-notice:not([hidden])');
  return { activity: rect(activity), section: rect(section), actions: rect(section.querySelector('.ws-actions')!),
    measurement: measurement ? rect(measurement) : null, support: support ? rect(support) : null,
    hiddenHeights: Array.from(section.querySelectorAll('[hidden]'), node => node.getBoundingClientRect().height) };
});
const fitsGlance = async (frame: FrameLocator) => {
  const layout = await glanceGeometry(frame);
  expect(layout.hiddenHeights.every(height => height === 0)).toBe(true);
  expect(layout.actions.y).toBeCloseTo(layout.activity.y + layout.activity.height, 5);
  expect(layout.section.height).toBeCloseTo(layout.activity.height + layout.actions.height, 5);
  const action = frame.getByRole('button', { name: 'Open MLX Scope', exact: true });
  await expect(action).toBeVisible();
  await action.focus();
  await expect(action).toBeFocused();
  expect(await frame.locator('#ws').evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await expect.poll(() => frame.locator('#ws').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight + 1)).toBe(true);
  return layout;
};

for (const theme of ['light', 'dark']) for (const fontSize of [16, 24, 32]) test(`Session keeps populated rows stable and collapses absent readings in ${theme} at ${fontSize}px text`, async ({ page }) => {
  await page.setViewportSize({ width: 260, height: 550 });
  await page.goto(`/v2?surface=status&state=splash-decode&chat=local&theme=${theme}`);
  await page.locator('iframe').evaluate(element => { (element as HTMLElement).style.width = '260px'; });
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#rate')).toBeVisible();
  await frame.locator('html').evaluate((element, size) => { (element as HTMLElement).style.fontSize = `${size}px`; }, fontSize);
  await setPhase(page, 'generating', 17.8);
  await expect(frame.locator('#rate')).toHaveText('17.8');
  const populated = await fitsGlance(frame);
  for (const [phase, label] of [['reasoning', 'Reasoning'], ['tool', 'Using tools'], ['waiting', 'Waiting'], ['complete', 'Complete'], ['cancelled', 'Stopped']] as const) {
    await setPhase(page, phase, phase === 'reasoning' ? 18.1 : phase === 'complete' ? 19.2 : undefined);
    await expect(frame.locator('.ws-phase')).toHaveText(label);
    await expect(frame.locator('.ws-measurement:visible')).toHaveCount(phase === 'reasoning' || phase === 'complete' ? 1 : 0);
    const layout = await fitsGlance(frame);
    expect(layout.actions.height, phase).toBe(populated.actions.height);
    if (phase === 'reasoning') {
      expect(layout.measurement).toEqual(populated.measurement);
      expect(layout.actions).toEqual(populated.actions);
      expect(layout.section).toEqual(populated.section);
    } else if (phase === 'complete') {
      expect(layout.measurement!.height).toBeGreaterThanOrEqual(populated.measurement!.height);
      await expect(frame.locator('.ws-support')).toContainText('Finished');
    } else {
      expect(layout.measurement).toBeNull();
      // A real unavailable-reading notice can replace the collapsed value, and both states may reach the
      // host's320px cap at200% text. The hidden slot itself must still have zero height (fitsGlance above).
      expect(layout.actions.y).toBeLessThanOrEqual(populated.actions.y);
      expect(layout.section.height).toBeLessThanOrEqual(populated.section.height);
    }
    await expect(frame.locator('#ws')).not.toContainText(/undefined|NaN|—/);
  }
  // A diagnostic note still owns its populated support row when no reading exists.
  await page.goto(`/v2?surface=status&state=offline&theme=${theme}`);
  await page.locator('iframe').evaluate(element => { (element as HTMLElement).style.width = '260px'; });
  await frame.locator('html').evaluate((element, size) => { (element as HTMLElement).style.fontSize = `${size}px`; }, fontSize);
  await expect(frame.locator('.ws-note')).toHaveText('Scope checks again automatically');
  const offline = await fitsGlance(frame);
  expect(offline.measurement).toBeNull();
  expect(offline.support!.height).toBeGreaterThan(0);
});

test('ordinary busy changes retain a fresh speed while the refresh is pending', async ({ page }) => {
  await page.goto('/v2?surface=status&state=decode&chat=local');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#rate')).toHaveText('26.4');
  await page.evaluate(() => {
    const w = window as any; w.previewDelay = true;
    w.setPreviewSession({ id: 'fixture-chat', title: 'Private title', busy: false, model: 'omlx/Example-27B-4bit' });
  });
  await expect.poll(() => page.evaluate(() => (window as any).previewDeferred.length)).toBeGreaterThan(0);
  await expect(frame.locator('#rate')).toHaveText('26.4');
  await expect(frame.locator('.ws-phase')).toHaveText('Generating');
  await page.evaluate(() => {
    const w = window as any;
    w.setPreviewSession({ id: 'fixture-chat', title: 'Private title', busy: true, model: 'omlx/Example-27B-4bit' });
  });
  await expect(frame.locator('#rate')).toHaveText('26.4');
  await page.evaluate(() => { const w = window as any; w.previewDelay = false; w.previewDeferred.splice(0).forEach((reply: () => void) => reply()); });
  await expect(frame.locator('#rate')).toHaveText('26.4');
});

for (const theme of ['light', 'dark']) test(`The Session panel fits its host at 200% text in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width: 260, height: 550 });
  for (const state of ['pressure', 'pressure-critical', 'needs-approval', 'unconfigured', 'offline', 'runtime-changed', 'contract-mismatch', 'prefill-stall']) {
    await page.goto(`/v2?surface=status&state=${state}&chat=local&theme=${theme}`);
    await page.locator('iframe').evaluate(element => { (element as HTMLElement).style.width = '260px'; });
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('.ws-phase')).toBeVisible();
    await frame.locator('html').evaluate(element => { (element as HTMLElement).style.fontSize = '32px'; });
    const headingRow = await frame.locator('#ws-heading').evaluate(context => {
      const children = Array.from(context.children, child => child.getBoundingClientRect());
      return { rowHeight: context.getBoundingClientRect().height,
        contentHeight: Math.max(...children.map(child => child.bottom)) - Math.min(...children.map(child => child.top)) };
    });
    const label = (reason: string) => `${reason} (mock state: ${state})`;
    expect(headingRow.rowHeight, label('The heading and menu should not reserve extra height at 200% text')).toBeLessThanOrEqual(headingRow.contentHeight + 1);
    await expect.poll(() => frame.locator('#ws').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight + 1), label('The Session panel should fit inside its host')).toBe(true);
    expect(await frame.locator('#ws').evaluate(() => document.documentElement.scrollWidth > innerWidth), label('Session text should stay within the panel width')).toBe(false);
    const action = frame.getByRole('button', { name: 'Open MLX Scope', exact: true });
    await expect(action).toBeVisible();
    expect(await action.evaluate(element => element.getBoundingClientRect().bottom <= innerHeight), label('The button should stay inside its host')).toBe(true);
    expect(await frame.locator('#ws').evaluate(element => element.getBoundingClientRect().height), label('The Session panel should stay within the host height limit')).toBeLessThanOrEqual(320);
  }
});

for (const width of [320, 1160]) for (const fontSize of [16, 32]) test(`full Live keeps populated parts stable and collapses empty parts at ${width}px and ${fontSize}px text`, async ({ page }) => {
  await page.setViewportSize({ width, height: 950 });
  await page.goto('/v2?surface=page&state=splash-decode&chat=local');
  const frame = page.frameLocator('iframe');
  await frame.locator('html').evaluate((element, size) => { (element as HTMLElement).style.fontSize = `${size}px`; }, fontSize);
  await setPhase(page, 'generating', 17.8);
  await expect(frame.locator('#rate')).toHaveText('17.8');
  await expect(frame.locator('#engine-trend')).toBeVisible();
  const readout = () => frame.locator('.instrument-readout').evaluate(element => {
    const parts = Array.from(element.querySelectorAll<HTMLElement>('.instrument-measure, .instrument-evidence'));
    // The standard layout uses display:contents for the wrapper; its real flex items own the space.
    return { occupied: parts.reduce((height, part) => {
      const style = getComputedStyle(part);
      return height + (style.display === 'none' ? 0 : part.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom));
    }, 0),
      parts: parts.map(part => ({
        quiet: part.dataset.quiet === 'true', height: part.getBoundingClientRect().height, content: part.innerText.trim().length > 0,
      })) };
  });
  const details = await position(frame, '#measurement-details > summary'), populated = await readout();
  for (const [phase, label] of [['reasoning', 'Reasoning'], ['tool', 'Using tools'], ['waiting', 'Waiting'], ['complete', 'Complete'], ['cancelled', 'Stopped']] as const) {
    await setPhase(page, phase, phase === 'reasoning' ? 18.1 : phase === 'complete' ? 19.2 : undefined);
    await expect(frame.locator('.instrument-phase')).toHaveText(label);
    await expect(frame.locator('.instrument-primary')).toHaveCount(phase === 'reasoning' || phase === 'complete' ? 1 : 0);
    const current = await readout(), controls = await position(frame, '#measurement-details > summary');
    for (const part of current.parts) {
      if (part.quiet) expect(part.height, phase).toBe(0);
      else expect(part.content, phase).toBe(true);
    }
    if (phase === 'reasoning') expect(current).toEqual(populated);
    if (!['reasoning', 'complete'].includes(phase)) expect(current.parts[0]!.quiet, phase).toBe(true);
    expect(controls.height, phase).toBe(details.height);
    expect(controls.y, phase).toBeCloseTo(details.y + current.occupied - populated.occupied, 4);
    await expect(frame.locator('#engine-trend')).toBeVisible();
    await expect(frame.locator('#measurement-details > summary')).toBeVisible();
    expect(await frame.locator('#scope').evaluate(() => document.documentElement.scrollWidth > innerWidth), phase).toBe(false);
  }
});
