import { expect, test, type FrameLocator, type Page } from '@playwright/test';

// 3.2 restores cloud delivery estimates through the qualified OpenCode 2.0.25 handshake. They are labelled
// Cloud · est., keep a stable layout through every phase, expire on time and never borrow a local engine reading.
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
const anchor = (frame: FrameLocator, selector: string) => frame.locator(selector).evaluate(element => {
  const rect = element.getBoundingClientRect(); return { y: rect.y, height: rect.height };
});

for (const surface of ['status', 'page']) for (const theme of ['light', 'obsidian']) {
  test(`cloud activity and delivery stay quiet and labelled on ${surface} in ${theme}, with media still available`, async ({ page }) => {
    await page.setViewportSize({ width: surface === 'status' ? 280 : 1160, height: 950 });
    await page.goto(`/v2?surface=${surface}&state=pressure&chat=cloud&theme=${theme}&poll=500&media=active`);
    const frame = page.frameLocator('iframe'), activity = surface === 'status' ? '.ws-phase' : '.instrument-phase';
    const source = surface === 'status' ? '.ws-label' : '.instrument-source';
    await expect(frame.locator(activity)).toHaveText('Ready');
    await expect(frame.locator('#rate')).toHaveCount(0);
    await expect(frame.locator(surface === 'status' ? '#ws' : '#panel-live')).not.toContainText('Memory pressure');
    await expect(frame.locator('#scope')).not.toContainText('Speed tracking is for local models.');
    await phase(page, 'generating', 17.8);
    await expect(frame.locator('#rate')).toHaveText('17.8');
    await expect(frame.locator(activity)).toHaveText('Generating');
    await expect(frame.locator(source)).toContainText('Cloud · est.');
    if (surface === 'page') {
      await expect(frame.locator('.cloud-scope')).toHaveText('Cloud speed is delivery observed through OpenCode, including network and provider buffering. Not engine throughput.');
      await expect(frame.locator('#phase')).toHaveText('Generating');
      await expect(frame.locator('#connection')).toBeHidden();
    }
    const stable = await anchor(frame, surface === 'status' ? '.ws-actions' : '#hero');
    for (const [value, label, rate] of [
      ['reasoning', 'Reasoning', 18.2], ['tool', 'Using tools', undefined], ['waiting', 'Waiting', undefined],
      ['complete', 'Complete', 5.6], ['cancelled', 'Stopped', undefined],
    ] as const) {
      await phase(page, value, rate);
      await expect(frame.locator(activity)).toHaveText(label);
      if (rate === undefined) await expect(frame.locator('#rate')).toHaveCount(0);
      else await expect(frame.locator('#rate')).toHaveText(String(rate));
      if (value === 'complete') await expect(frame.locator(source)).toContainText('Last cloud · avg.');
      expect(await anchor(frame, surface === 'status' ? '.ws-actions' : '#hero')).toEqual(stable);
    }
    if (surface === 'page') {
      await expect(frame.locator('#measurement-details')).toHaveCount(0);
      await expect(frame.locator('#engine-trend, .machine-summary, #reply-strip')).toHaveCount(0);
    }
    // Media stays available during a cloud chat: the glance in the sidebar, the column's Media block on the page.
    if (surface === 'status') await expect(frame.locator('.media-glance')).toBeVisible();
    else {
      await expect(frame.locator('#view-media')).toBeVisible();
      await expect(frame.getByRole('progressbar', { name: 'Sampling progress · this phase only' })).toHaveAttribute('aria-valuenow', '40');
    }
    expect(await page.evaluate(() => (window as any).previewUnexpectedSends)).toBe(0);
  });
}

for (const surface of ['status', 'page']) test(`cloud ${surface} clears expired rates while a poll stalls`, async ({ page }) => {
  await page.clock.install();
  await page.goto(`/v2?surface=${surface}&state=decode&chat=cloud&poll=500`);
  const frame = page.frameLocator('iframe');
  await phase(page, 'generating', 17.8);
  await page.clock.fastForward(600);
  await expect(frame.locator('#rate')).toHaveText('17.8');
  await page.evaluate(() => { (window as any).previewHold = true; });
  await page.clock.fastForward(5_100);
  await expect(frame.locator('#rate')).toHaveCount(0);
});

for (const surface of ['status', 'page']) test(`cloud ${surface} clears a rate immediately on chat or model switch`, async ({ page }) => {
  await page.goto(`/v2?surface=${surface}&state=decode&chat=cloud&poll=500`);
  const frame = page.frameLocator('iframe');
  await phase(page, 'generating', 21.3);
  await expect(frame.locator('#rate')).toHaveText('21.3');
  await page.evaluate(() => {
    const w = window as any; w.previewHold = true;
    w.setPreviewSession({ id: 'different-fixture-chat', busy: true, model: 'cloud-provider/different-model' });
  });
  await expect(frame.locator('#rate')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).previewQueries.at(-1)?.chatBusy)).toBe('1');
  const query = await page.evaluate(() => (window as any).previewQueries.at(-1));
  expect(query.provider).toBe('cloud-provider');
  expect(query.runtime).toBeUndefined();
});
