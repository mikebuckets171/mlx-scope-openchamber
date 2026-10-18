import { expect, test } from '@playwright/test';

test('a render before the queued native toggle event keeps the reader’s disclosure choice', async ({ page }) => {
  await page.goto('/v2?surface=page&state=decode');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#rate')).toHaveText('26.4');
  const details = frame.locator('#measurement-details');
  for (const open of [true, false]) {
    const actual = await details.evaluate(node => {
      const details = node as HTMLDetailsElement;
      details.querySelector<HTMLElement>(':scope > summary')!.click();
      // Change another disclosure so a render patches the DOM before the queued native toggle event.
      document.querySelector<HTMLElement>('.instrument-source [data-disclose]')!.click();
      return details.open;
    });
    expect(actual).toBe(open);
    await expect(details).toHaveJSProperty('open', open);
  }
});
