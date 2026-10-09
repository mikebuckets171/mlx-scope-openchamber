import { expect, test, type Page } from '@playwright/test';
import { chatKey } from '../../src/contract/chat-key.ts';

const latestQuery = (page: Page) => page.evaluate(() => (window as any).previewQueries.at(-1) as Record<string, string> | undefined);

for (const savedScope of [null, 'chat', 'engine'] as const) {
  test(`restoring a saved connection preserves ${savedScope ?? 'the default chat'} scope`, async ({ page }) => {
    await page.addInitScript(scope => {
      if (window.parent !== window) return;
      sessionStorage.setItem('connection.selection', JSON.stringify({ provider: 'saved-local', runtime: 'splash' }));
      sessionStorage.setItem('pref.v2', JSON.stringify({ v: 2, history: false, ...(scope ? { measurementScope: scope } : {}) }));
    }, savedScope);
    await page.goto('/v2?surface=page&state=decode&chat=local');
    const frame = page.frameLocator('iframe'), scope = frame.locator('#measurement-choice').getByRole('combobox', { name: 'Measurement scope' });
    await frame.locator('#monitor-menu > summary').click();
    await expect(scope).toHaveValue(savedScope ?? 'chat');
    await expect.poll(() => latestQuery(page)).toMatchObject(savedScope === 'engine'
      ? { provider: 'saved-local', runtime: 'splash' }
      : { provider: 'omlx', chat: chatKey('session', 'fixture-chat'), chatModel: chatKey('model', 'Example-27B-4bit') });
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('pref.v2')!).measurementScope ?? null)).toBe(savedScope);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('connection.selection')!)))
      .toEqual({ provider: 'saved-local', runtime: 'splash' });

    if (savedScope !== 'chat') return;
    // Confirming the same saved connection is still a deliberate Whole engine choice.
    await frame.locator('#connection-change').click();
    await expect(frame.locator('#connection-provider')).toHaveValue('saved-local');
    await expect(frame.locator('#connection-runtime')).toHaveValue('splash');
    await frame.locator('#connection-apply').click();
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('pref.v2')!).measurementScope)).toBe('engine');
    await expect.poll(() => latestQuery(page)).toMatchObject({ provider: 'saved-local', runtime: 'splash' });
    expect((await latestQuery(page))?.chat).toBeUndefined();

    // A different deliberate connection continues to change both the scope and selection.
    await frame.locator('#monitor-menu > summary').click();
    await scope.selectOption('chat');
    await frame.locator('#connection-change').click();
    await frame.locator('#connection-provider').selectOption('omlx');
    await frame.locator('#connection-runtime').selectOption('');
    await frame.locator('#connection-apply').click();
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('pref.v2')!).measurementScope)).toBe('engine');
    await expect.poll(() => latestQuery(page)).toMatchObject({ provider: 'omlx' });
    expect((await latestQuery(page))?.chat).toBeUndefined();
  });
}
