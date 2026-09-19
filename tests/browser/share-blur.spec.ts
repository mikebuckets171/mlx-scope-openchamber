import { expect, test } from '@playwright/test';

test('Share dismisses when focus returns to the surrounding host', async ({ page }) => {
  await page.goto('/?state=decode&chat=1');
  const frame = page.frameLocator('iframe');
  const share = frame.getByRole('button', { name: 'Share', exact: true });
  const menu = frame.getByRole('menu', { name: 'Share readings' });
  await share.focus();
  await share.press('Enter');
  await expect(menu).toBeVisible();
  await expect(frame.getByRole('menuitem', { name: 'Copy stats', exact: true })).toBeFocused();

  await page.locator('aside').click();
  await expect(menu).toBeHidden();
  await expect(share).toHaveAttribute('aria-expanded', 'false');
  expect(await frame.locator('body').evaluate(() => document.hasFocus())).toBe(false);

  await share.focus();
  await share.press('ArrowDown');
  await expect(menu).toBeVisible();
  await frame.getByRole('menuitem', { name: 'Copy stats', exact: true }).press('Escape');
  await expect(menu).toBeHidden();
  await expect(share).toBeFocused();
});
