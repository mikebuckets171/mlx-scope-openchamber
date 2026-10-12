import { expect, test } from '@playwright/test';

for (const legacy of [false, true]) test(`companion compatibility disclosure keeps ${legacy ? 'legacy' : 'per-feature'} support separate from activity`, async ({ page }) => {
  await page.goto('/v2?surface=page&state=decode&chat=local');
  if (!legacy) await page.evaluate(() => {
    const original = window.ScopeMediaFixtures.respond.bind(window.ScopeMediaFixtures);
    window.ScopeMediaFixtures.respond = message => {
      const response = original(message);
      if (message.payload.path !== '/v2/companion/setup' || !response) return response;
      const body = JSON.parse(response.body);
      return { ...response, body: JSON.stringify({ ...body, state: 'ready', configured: true, canEnable: false,
        compatibility: { profile: 'opencode-2.0.25-v1', activity: 'awaiting-demand', features: {
          'http-delivery': { support: 'qualified', available: true },
          'websocket-delivery': { support: 'unavailable', available: false },
          'prompt-progress': { support: 'qualified', available: false },
          'managed-reload': { support: 'qualified', available: true },
        } } }) };
    };
  });
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Connections', exact: true }).click();
  const setup = frame.locator('#companion-setup');
  await setup.locator('.setup-versions > summary').click();
  const detail = setup.locator('[data-companion-compatibility]');
  await expect(detail).toBeVisible();
  if (legacy) {
    await expect(detail).toContainText('Feature qualification was not reported');
    await expect(detail.locator('ul')).toHaveCount(0);
  } else {
    await expect(detail).toContainText('Ready for the next observed step');
    await expect(detail.locator('[data-companion-feature="http-delivery"]')).toHaveText('HTTP delivery: qualified · available');
    await expect(detail.locator('[data-companion-feature="websocket-delivery"]')).toHaveText('WebSocket delivery: unavailable');
  }
  await expect(detail).toContainText('bun run qualify:compatibility');
  await expect(detail).toContainText('does not qualify a live host');
  expect(await page.evaluate(() => window.previewAuxiliaryRequests.filter((item: { path: string; method: string }) =>
    item.path === '/v2/companion/setup' && item.method !== 'GET').length)).toBe(0);
  expect(await detail.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});
