import { expect, test } from '@playwright/test';

test('model names from OpenCode reach Live and server cards and follow a renamed config entry', async ({ page }) => {
  await page.goto('/v2?surface=page&state=splash-decode');
  await page.evaluate(() => {
    const body = window.ScopeStates.mockBody('splash-decode', { now: Date.now() });
    const model = 'org/fixture-model-GGUF';
    body.connection.modelNames = [{ model, name: 'Friendly model' }];
    body.runtime.catalog[0].name = `${model}:IQ3_XXS`;
    window.setPreviewPatch({ connection: body.connection, runtime: body.runtime });
  });
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.precision-model')).toHaveText('Friendly model');
  await frame.locator('#measurement-details > summary').click();
  await expect(frame.locator('[data-key="server-catalog"]')).toContainText('Friendly model');
  await expect(frame.locator('[data-key="server-catalog"]')).not.toContainText('org/fixture-model-GGUF');
  await page.evaluate(() => {
    window.previewPatch.connection.modelNames[0].name = 'Renamed model';
  });
  await expect(frame.locator('.precision-model')).toHaveText('Renamed model');
  await expect(frame.locator('[data-key="server-catalog"]')).toContainText('Renamed model');
});
