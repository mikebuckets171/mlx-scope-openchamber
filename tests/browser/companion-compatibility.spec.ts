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
    await expect(detail).toContainText('Feature checks were not reported.');
    await expect(detail.locator('ul')).toHaveCount(0);
  } else {
    await expect(detail).toContainText('Ready for the next observed step');
    // Support claims alone never read as working: an available feature waits for its first passing check.
    await expect(detail.locator('[data-companion-feature="http-delivery"]')).toHaveText('HTTP delivery: waiting for the next reply');
    await expect(detail.locator('[data-companion-feature="websocket-delivery"]')).toHaveText('WebSocket delivery: unavailable');
  }
  await expect(detail).toContainText('bun run qualify:compatibility');
  await expect(detail).toContainText('does not qualify a live host');
  expect(await page.evaluate(() => window.previewAuxiliaryRequests.filter((item: { path: string; method: string }) =>
    item.path === '/v2/companion/setup' && item.method !== 'GET').length)).toBe(0);
  expect(await detail.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test('a qualified newer runtime can update an older helper without presenting unsupported telemetry as ready', async ({ page }) => {
  await page.goto('/v2?surface=page&state=decode&chat=local');
  await page.evaluate(() => {
    const original = window.ScopeMediaFixtures.respond.bind(window.ScopeMediaFixtures);
    let loaded = false;
    window.ScopeMediaFixtures.respond = message => {
      const response = original(message);
      if (message.payload.path !== '/v2/companion/setup' || !response) return response;
      if (message.payload.method === 'POST') loaded = true;
      return { ...response, body: JSON.stringify({ ...JSON.parse(response.body),
        state: loaded ? 'ready' : 'pending', configured: true, canEnable: !loaded, live: false,
        runtimeVersion: '2.0.27', companionVersion: loaded ? '3.3.0' : '3.2.0',
        protocol: loaded ? 'opencode-2.0.25' : 'unsupported',
        message: loaded ? 'Chat tracking is ready for your next reply.' : 'Update chat speed to install the current tracking helper.' }) };
    };
  });
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Connections', exact: true }).click();
  const setup = frame.locator('#companion-setup');
  await expect(setup.locator('[data-companion-status]')).toContainText('Update chat speed');
  await setup.getByRole('button', { name: 'Update chat speed', exact: true }).click();
  await expect(setup.locator('[data-companion-status]')).toContainText('ready for your next reply');
  await setup.locator('.setup-versions > summary').click();
  await expect(setup.locator('[data-companion-version]')).toContainText('OpenCode 2.0.27 · Companion 3.3.0');
  await expect(setup.getByRole('button', { name: 'Update chat speed', exact: true })).toBeHidden();
});
