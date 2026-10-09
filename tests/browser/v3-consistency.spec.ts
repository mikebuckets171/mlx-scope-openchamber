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

for (const theme of ['light', 'dark']) for (const fontSize of [16, 24, 32]) test(`Session controls hold position across absent readings in ${theme} at ${fontSize}px text`, async ({ page }) => {
  await page.setViewportSize({ width: 260, height: 550 });
  await page.goto(`/v2?surface=status&state=splash-decode&chat=local&theme=${theme}`);
  await page.locator('iframe').evaluate(element => { (element as HTMLElement).style.width = '260px'; });
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#rate')).toBeVisible();
  await frame.locator('html').evaluate((element, size) => { (element as HTMLElement).style.fontSize = `${size}px`; }, fontSize);
  await setPhase(page, 'generating', 17.8);
  await expect(frame.locator('#rate')).toHaveText('17.8');
  const actions = await position(frame, '.ws-actions'), section = await position(frame, '#ws');
  for (const [phase, label] of [['reasoning', 'Reasoning'], ['tool', 'Using tools'], ['waiting', 'Waiting'], ['complete', 'Complete'], ['cancelled', 'Stopped']] as const) {
    await setPhase(page, phase, phase === 'reasoning' ? 18.1 : phase === 'complete' ? 19.2 : undefined);
    await expect(frame.locator('.ws-phase')).toHaveText(label);
    await expect(frame.locator('.ws-measurement')).toHaveCount(phase === 'reasoning' || phase === 'complete' ? 1 : 0);
    expect(await position(frame, '.ws-actions'), phase).toEqual(actions);
    expect(await position(frame, '#ws'), phase).toEqual(section);
    await expect(frame.locator('#ws')).not.toContainText(/undefined|NaN|—/);
  }
  const overflows = await frame.locator('#ws').evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflows).toBe(false);
  await expect.poll(() => frame.locator('#ws').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight + 1)).toBe(true);
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

for (const theme of ['light', 'dark']) test(`Session priority information fits the host clamp at 200% text in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width: 260, height: 550 });
  for (const state of ['pressure', 'pressure-critical', 'needs-approval', 'unconfigured', 'offline', 'runtime-changed', 'contract-mismatch', 'prefill-stall']) {
    await page.goto(`/v2?surface=status&state=${state}&chat=local&theme=${theme}`);
    await page.locator('iframe').evaluate(element => { (element as HTMLElement).style.width = '260px'; });
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('.ws-phase')).toBeVisible();
    await frame.locator('html').evaluate(element => { (element as HTMLElement).style.fontSize = '32px'; });
    await expect.poll(() => frame.locator('#ws').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight + 1), state).toBe(true);
    expect(await frame.locator('#ws').evaluate(() => document.documentElement.scrollWidth > innerWidth), state).toBe(false);
    const action = frame.getByRole('button', { name: 'Open MLX Scope', exact: true });
    await expect(action).toBeVisible();
    expect(await action.evaluate(element => element.getBoundingClientRect().bottom <= innerHeight), state).toBe(true);
    expect(await frame.locator('#ws').evaluate(element => element.getBoundingClientRect().height), state).toBeLessThanOrEqual(320);
  }
});

for (const width of [320, 1160]) for (const fontSize of [16, 32]) test(`full Live keeps controls in position across phase changes at ${width}px and ${fontSize}px text`, async ({ page }) => {
  await page.setViewportSize({ width, height: 950 });
  await page.goto('/v2?surface=page&state=splash-decode&chat=local');
  const frame = page.frameLocator('iframe');
  await frame.locator('html').evaluate((element, size) => { (element as HTMLElement).style.fontSize = `${size}px`; }, fontSize);
  await setPhase(page, 'generating', 17.8);
  await expect(frame.locator('#rate')).toHaveText('17.8');
  await expect(frame.locator('#engine-trend')).toBeVisible();
  const trend = await position(frame, '#measurement-details > summary');
  for (const [phase, label] of [['reasoning', 'Reasoning'], ['tool', 'Using tools'], ['waiting', 'Waiting'], ['complete', 'Complete'], ['cancelled', 'Stopped']] as const) {
    await setPhase(page, phase, phase === 'reasoning' ? 18.1 : phase === 'complete' ? 19.2 : undefined);
    await expect(frame.locator('.instrument-phase')).toHaveText(label);
    await expect(frame.locator('.instrument-primary')).toHaveCount(phase === 'reasoning' || phase === 'complete' ? 1 : 0);
    expect(await position(frame, '#measurement-details > summary'), phase).toEqual(trend);
    expect(await frame.locator('#scope').evaluate(() => document.documentElement.scrollWidth > innerWidth), phase).toBe(false);
  }
});
