import { expect, test, type Page } from '@playwright/test';

type Phase = 'generating' | 'reasoning' | 'tool' | 'waiting' | 'complete' | 'cancelled';
const phase = (page: Page, value: Phase, rate?: number) => page.evaluate(({ value, rate }) => {
  const now = Date.now();
  (window as any).setPreviewPatch({ chat: { scope: 'chat',
    basis: value === 'complete' ? 'reported-output' : 'estimated-characters',
    timingBasis: value === 'complete' ? 'completed-step' : 'delivery-window', phase: value,
    ...(rate === undefined ? {} : { tokensPerSecond: rate }), observedAtMs: now,
    expiresAtMs: now + 5_000, observation: { startedAtMs: now - 3_000, endedAtMs: now },
    freshness: value === 'complete' ? 'last' : 'live' } });
}, { value, rate });
for (const surface of ['status', 'page', 'panel']) for (const theme of ['light', 'obsidian']) {
  test(`cloud stays clearly inactive on ${surface} in ${theme}, with media still available`, async ({ page }) => {
    await page.setViewportSize({ width: surface === 'page' ? 1160 : 280, height: 950 });
    await page.goto(`/v2?surface=${surface}&state=pressure&chat=cloud&theme=${theme}&poll=500&media=active`);
    const frame = page.frameLocator('iframe'), activity = surface === 'status' ? '.ws-phase' : '.instrument-phase';
    await expect(frame.locator(activity)).toHaveText('Cloud chat');
    await expect(frame.locator('#rate')).toHaveCount(0);
    await expect(frame.locator('#scope')).toContainText('Speed tracking is for local models.');
    await expect(frame.locator('[data-action="chat-setup"]')).toHaveCount(0);
    for (const value of ['generating', 'reasoning', 'waiting', 'tool', 'complete', 'cancelled'] as const) {
      await phase(page, value, ['generating', 'reasoning', 'complete'].includes(value) ? 17.8 : undefined);
      await expect(frame.locator(activity)).toHaveText('Cloud chat');
      await expect(frame.locator('#rate')).toHaveCount(0);
    }
    await expect(frame.locator(surface === 'status' ? '#ws' : '#panel-live')).not.toContainText('Memory pressure');
    await expect(frame.locator('.media-glance')).toBeVisible();
    if (surface !== 'status') {
      await frame.getByRole('tab', { name: 'Media', exact: true }).click();
      await expect(frame.getByRole('progressbar', { name: 'Sampling progress · this phase only' })).toHaveAttribute('aria-valuenow', '40');
    }
    expect(await page.evaluate(() => (window as any).previewUnexpectedSends)).toBe(0);
  });
}
