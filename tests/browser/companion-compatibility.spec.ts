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

test('an older helper from Scope 5 is named as such, then the extension’s helper takes over with no button to press', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/v2?surface=page&state=decode&chat=local');
  await page.evaluate(() => {
    const original = window.ScopeMediaFixtures.respond.bind(window.ScopeMediaFixtures);
    window.ScopeMediaFixtures.respond = message => {
      const response = original(message);
      if (message.payload.path !== '/v2/companion/setup' || !response) return response;
      const loaded = window.previewHelperLoaded === true;
      const features = Object.fromEntries(['http-delivery', 'websocket-delivery', 'prompt-progress', 'managed-reload']
        .map(id => [id, { support: 'compatible', available: true, check: { state: loaded ? 'passed' : 'waiting' } }]));
      return { ...response, body: JSON.stringify({ ...JSON.parse(response.body),
        state: loaded ? 'ready' : 'pending', configured: loaded, managed: !loaded, canEnable: false, canDisable: false, live: false,
        runtimeVersion: '2.2.6', companionVersion: loaded ? '3.7.0' : '3.6.0', protocol: 'opencode-2.0.25',
        compatibility: { profile: null, mode: 'self-checked', activity: 'awaiting-demand', features },
        message: loaded ? 'Chat tracking is ready for your next reply.'
          : 'An older chat-speed helper from MLX Scope 5 is still loaded. MLX Scope switches to the one that comes with this release when no reply is running; your current work can continue.' }) };
    };
  });
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Connections', exact: true }).click();
  const setup = frame.locator('#companion-setup');
  await expect(setup.locator('[data-companion-status]')).toContainText('older chat-speed helper from MLX Scope 5');
  await expect(setup.locator('[data-companion-status]')).not.toContainText('ready for your next reply');
  // Nothing to enable, update or remove here: the helper comes with the extension.
  await expect(setup.getByRole('button', { name: /enable|update|disable/i })).toHaveCount(0);
  await page.evaluate(() => { window.previewHelperLoaded = true; });
  await setup.getByRole('button', { name: 'Check status', exact: true }).click();
  await expect(setup.locator('[data-companion-status]')).toContainText('ready for your next reply');
  await setup.locator('.setup-versions > summary').click();
  await expect(setup.locator('[data-companion-version]')).toContainText('OpenCode 2.2.6 · Companion 3.7.0');
  await expect(setup.locator('[data-companion-compatibility]')).toContainText('OpenCode 2.2.6 · self-checked, not yet qualified');
  await expect(setup.locator('.setup-versions')).toContainText('comes with MLX Scope');
  expect(await page.evaluate(() => window.previewAuxiliaryRequests.filter((item: { path: string; method: string }) =>
    item.path === '/v2/companion/setup' && item.method !== 'GET').length)).toBe(0);
});
