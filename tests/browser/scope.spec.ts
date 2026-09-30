import { expect, test, type Page } from '@playwright/test';

// Stage 7/11: the /scope background frame and the OpenChamber 2.0.4 host emulation other tracks build on.
type Host = {
  previewResolved: Array<{ item?: Record<string, string> | null; error?: string }>; previewQueries: Record<string, string>[];
  previewRequests: number; previewStorage: Record<string, number>; previewBadges: unknown[]; previewToasts: unknown[];
  previewHeights: number[]; previewUnexpectedSends: number; previewTransportError: string;
};
/** Runs an expression against the synthetic host's window hooks. */
const host = (page: Page, expression: string) => page.evaluate(expression);
const state = (page: Page) => page.evaluate(() => { const w = window as unknown as Host;
  return { resolved: w.previewResolved, queries: w.previewQueries, requests: w.previewRequests, storage: w.previewStorage, badges: w.previewBadges,
    toasts: w.previewToasts, heights: w.previewHeights, sends: w.previewUnexpectedSends, transport: w.previewTransportError }; });
const ARGS = 'CANARY-ARGS /Users/fixture/secret sk-CANARY-7f3a-key';

for (const transport of ['direct', 'relay']) {
  test(`/scope (${transport}): one background read, a sanitized chip, no writes, no polling`, async ({ page }) => {
    await page.goto(`/?surface=background&state=decode&args=${encodeURIComponent(ARGS)}${transport === 'relay' ? '&transport=relay' : ''}`);
    await expect.poll(async () => (await state(page)).resolved.length).toBe(1);
    await page.waitForTimeout(1_500);
    const after = await state(page);
    expect(after.transport).toBe('');
    expect(after.queries).toEqual([{ surface: 'background', tier: 'glance' }]);
    expect(after.requests).toBe(1);
    // The saved connection, then the baseline and the model dictionary.
    expect(after.storage).toMatchObject({ gets: 3, keys: 0, sets: 0, deletes: 0 });
    expect([after.badges, after.toasts, after.heights, after.sends]).toEqual([[], [], [], 0]);
    const item = after.resolved[0]!.item!;
    expect(item).toMatchObject({ providerId: 'mlx-scope', id: 'mlx-scope-diagnostics', title: 'MLX Scope diagnostics', kind: 'issue' });
    expect(item.url).toMatch(/^https:\/\/github\.com\/mikebuckets171\/mlx-scope-openchamber\/blob\/(main|v\d+\.\d+\.\d+)\/README\.md#scope-diagnostics$/);
    expect(item.text!.split('\n')[0]).toBe("Sent to this chat's model, which may be a cloud provider.");
    expect(item.text).toContain('Runtime: oMLX, status ready, phase decode');
    expect(item.text).toMatch(/Current request: decode \d+(\.\d)? tok\/s \(reported\)/);
    for (const canary of ['CANARY', '/Users/', 'sk-CANARY', 'Qwen3.8', 'Local coding session', 'synthetic-chat']) expect(JSON.stringify(item)).not.toContain(canary);
  });
}

test('/scope names a stale service instead of attaching an empty chip', async ({ page }) => {
  await page.goto('/?surface=background&contract=1.6');
  await expect.poll(async () => (await state(page)).resolved).toEqual([
    { error: 'MLX Scope’s service is out of date. Pause and resume MLX Scope in Settings → Extensions.' }]);
});

test('2.0.4 emulation: status height, badge and toast recorders, lifecycle replays, storage limits, lease extras', async ({ page }) => {
  // The one-time tip and first-run notice are dismissed, so the section settles on one height.
  await page.goto('/?surface=status');
  await page.evaluate(() => sessionStorage.setItem('pref.v2', JSON.stringify({ tipDismissed: true, noticeDismissed: true })));
  await page.goto('/?surface=status&chat=1&lifecycle=3&state=idle');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#ws')).toBeVisible();
  // Status frames start at 72 px; the section then sizes itself with setHeight.
  await expect.poll(async () => (await state(page)).heights.length).toBeGreaterThan(0);
  const send = (message: object) => frame.locator('body').evaluate((_, value) => parent.postMessage({ channel: 'openchamber.sdk', v: 1, ...value }, '*'), message);
  await send({ type: 'resize', id: 'h1', payload: { height: 500 } });
  await send({ type: 'badge', id: 'b1', payload: { count: 2 } });
  await send({ type: 'toast', id: 't1', payload: { kind: 'info', message: 'fixture toast' } });
  await expect.poll(async () => [(await state(page)).heights.at(-1), (await state(page)).badges.at(-1), (await state(page)).toasts])
    .toEqual([500, 2, [{ kind: 'info', message: 'fixture toast' }]]);
  expect(await page.locator('iframe').evaluate(node => (node as HTMLIFrameElement).style.height)).toBe('320px');

  // Lifecycle: a scripted phase, repeated as the host repeats it.
  await frame.locator('body').evaluate(() => {
    (window as unknown as { lifecycle: unknown[] }).lifecycle = [];
    addEventListener('message', event => { if (event.data?.type === 'session-lifecycle') (window as unknown as { lifecycle: unknown[] }).lifecycle.push(event.data.payload); });
  });
  await host(page, `window.pushPreviewLifecycle('completed', 3)`);
  await expect.poll(() => frame.locator('body').evaluate(() => (window as unknown as { lifecycle: unknown[] }).lifecycle))
    .toEqual(Array(3).fill({ sessionId: 'synthetic-chat', phase: 'completed' }));

  // Storage: the namespace file is rewritten whole, and a write past a limit is HOST_REJECTED.
  await host(page, 'window.setPreviewStorageLimits({ totalBytes: 2000 })');
  await send({ type: 'storage', id: 's1', payload: { op: 'set', key: 'fixture.a', value: 'x'.repeat(500) } });
  await send({ type: 'storage', id: 's2', payload: { op: 'set', key: 'fixture.b', value: 'x'.repeat(2_000) } });
  await expect.poll(async () => (await state(page)).storage).toMatchObject({ sets: 1, rejected: 1 });
  expect((await state(page)).storage.rewrittenBytes).toBeGreaterThan(500);

  // Leader handover is a service fact: the next bodies carry the lease the test sets.
  await host(page, `window.setPreviewExtras({ lease: { leader: false, epoch: 2, ttlMs: 12000, leaderSurface: 'page' } })`);
  await expect.poll(() => host(page, 'window.previewLastResponse.body.lease')).toEqual({ leader: false, epoch: 2, ttlMs: 12_000, leaderSurface: 'page' });
});
