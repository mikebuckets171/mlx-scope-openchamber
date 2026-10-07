import { expect, test, type FrameLocator, type Page } from '@playwright/test';

// Connection selection on the synthetic 1.x host: what is stored, what each poll asks for, and that a switch never
// shows the previous connection's readings. Runtime coverage per connection is honest: nothing reported, nothing shown.
type W = Window & Record<string, any>;
const openMenu = async (frame: FrameLocator): Promise<void> => {
  if (!(await frame.locator('#monitor-menu').evaluate(element => (element as HTMLDetailsElement).open))) await frame.locator('#monitor-menu > summary').click();
};
const menu = async (frame: FrameLocator, selector: string): Promise<void> => { await openMenu(frame); await frame.locator(selector).click(); };
const open = async (page: Page, query = '') => {
  await page.goto(`/?connections=1&state=prefill&${query}`);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#phase')).not.toHaveText('Connecting');
  return frame;
};
const selection = async (page: Page) => { const { provider, runtime } = await page.evaluate(() => (window as W).previewQueries.at(-1)); return { provider, runtime }; };
const choose = async (page: Page, provider: string, runtime = '') => {
  const frame = page.frameLocator('iframe');
  await menu(frame, '#connection-change');
  await frame.getByLabel('Connection', { exact: true }).selectOption(provider);
  await frame.getByLabel('Runtime', { exact: true }).selectOption(runtime);
  await frame.getByRole('button', { name: 'Use connection', exact: true }).click();
};
const server = async (frame: FrameLocator) => frame.getByRole('button', { name: 'Server & Mac details', exact: true }).click();
const live = async (frame: FrameLocator) => frame.getByRole('tab', { name: 'Live', exact: true }).click();

test('a chosen connection is stored without credentials, sent with each poll, and survives reload', async ({ page }) => {
  const frame = await open(page);
  await expect(frame.locator('#prefill-percent')).toHaveText('64%');
  await choose(page, 'studio');
  await expect(frame.locator('#connection')).toHaveText('LM Studio local');
  await expect(frame.locator('#rate')).toHaveText('Connected');
  await expect(frame.locator('#hero')).toContainText('LM Studio lists its models · no live request readings');
  await expect(frame.locator('#metrics')).toHaveCount(0);
  await expect(frame.locator('.machine-summary')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('connection.selection')!))).toEqual({ provider: 'studio', runtime: null });
  expect(await selection(page)).toEqual({ provider: 'studio' });
  await server(frame);
  await expect(frame.locator('[data-key="server-catalog"]')).toContainText('32.8K context');
  await expect(frame.locator('[data-key="server-catalog"]')).toContainText('gguf');
  await page.reload();
  await expect(frame.locator('#connection')).toHaveText('LM Studio local');
  await choose(page, 'omlx');
  await live(frame);
  await expect(frame.locator('#prefill-percent')).toHaveText('64%');
});

test('an inventory never invents residency or request activity', async ({ page }) => {
  const frame = await open(page);
  await choose(page, 'mlx');
  await expect(frame.locator('#connection')).toHaveText('mlx-lm local');
  await expect(frame.locator('#metrics')).toHaveCount(0);
  await server(frame);
  await expect(frame.locator('[data-key="server-catalog"]')).toContainText('Listed');
  await expect(frame.locator('[data-key="server-catalog"]')).not.toContainText(/Loaded|not reported/);
  await expect(frame.locator('[data-key="server-residency"]')).toHaveCount(0);
  await expect(frame.locator('[data-key="server-memory"]')).toHaveCount(0);
});

test('standalone Splash: server-wide averages and Metal memory stay separate, and shares carry no model name', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const frame = await open(page);
  await choose(page, 'splash');
  await expect(frame.locator('#connection')).toHaveText('Inco AI Splash');
  await expect(frame.locator('#model')).toHaveText('incoai/Qwen3.8-27B-Splash');
  await expect(frame.locator('#rate')).toHaveText('Idle');
  await expect(frame.locator('#metrics')).toHaveCount(0);
  await server(frame);
  await expect(frame.locator('[data-key="server-session"]')).toContainText('47.2 tok/s');
  await expect(frame.locator('[data-key="server-session"]')).toContainText('1 failed');
  await expect(frame.locator('[data-key="server-memory"]')).toContainText('Metal memory');
  await expect(frame.locator('[data-key="server-memory"]')).toContainText('11.6 GiB');
  expect(await frame.locator('#scope').evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await openMenu(frame); await frame.getByRole('button', { name: 'Share', exact: true }).click();
  await frame.getByRole('menuitem', { name: 'Copy stats', exact: true }).click();
  await expect(frame.locator('#action-status')).toContainText('Stats copied');
  const shared = await page.evaluate(() => (window as W).previewCopied as string);
  expect(shared).toContain('Splash average since engine start (all requests): 47.2 tok/s');
  expect(shared).not.toMatch(/Recent engine speed[^\n]*47\.2 tok\/s/);
  expect(shared).not.toContain('Qwen3.8-27B-Splash');
});

test('a loading Splash server says so once and shows no decode rate', async ({ page }) => {
  const frame = await open(page, 'splashReady=0');
  await choose(page, 'splash');
  await expect(frame.locator('#phase')).toHaveText('Loading');
  await expect(frame.locator('#view-live > .connection-diagnosis')).toContainText('Splash is loading a model');
  await expect(frame.locator('#rate')).toHaveCount(0);
});

test('Splash in Bionic is named, keeps its last reply exact, and lists its Splash models', async ({ page }) => {
  const frame = await open(page, 'bionic=decode');
  await choose(page, 'bionic');
  await expect(frame.locator('#connection')).toHaveText('Splash via Bionic');
  await expect(frame.locator('#phase')).toHaveText('Generating');
  await expect(frame.locator('#model')).toHaveText('local/qwen3.8-27b-splash-levels');
  await expect(frame.locator('#rate')).toHaveText('Working');
  await expect(frame.locator('#reply-strip')).toContainText('38.6');
  await expect(frame.locator('#reply-strip')).toContainText('0.50 s');
  await expect(frame.locator('#panel-live')).not.toContainText(/LM Studio|not reported/);
  await server(frame);
  await expect(frame.locator('[data-key="server-catalog"] .chip[data-tone="accent"]')).toHaveCount(5);
  await menu(frame, '#connection-change');
  await expect(frame.getByLabel('Connection', { exact: true }).locator('option[value="bionic"]')).toHaveText('Splash (Bionic)');
  await expect(frame.locator('#connection-choice-note')).toContainText('Using Splash in Bionic? Keep Automatic.');
});

test('connection setup closes on Escape back to the menu button, and a custom provider takes an explicit runtime', async ({ page }) => {
  const frame = await open(page);
  await openMenu(frame);
  await frame.locator('#connection-change').focus(); await frame.locator('#connection-change').press('Enter');
  await expect(frame.locator('#connection-setup')).toBeVisible();
  await frame.getByLabel('Connection', { exact: true }).press('Escape');
  await expect(frame.locator('#connection-setup')).toBeHidden();
  await expect(frame.locator('#monitor-menu > summary')).toBeFocused();
  await choose(page, 'custom', 'lmstudio');
  await expect(frame.locator('#connection')).toHaveText('Custom local');
  expect(await selection(page)).toEqual({ provider: 'custom', runtime: 'lmstudio' });
});

test('a storage failure keeps the chosen connection usable; a missing setup points at Connection…', async ({ page }) => {
  let frame = await open(page, 'storage=fail');
  await choose(page, 'studio');
  await expect(frame.locator('#connection')).toHaveText('LM Studio local');
  await expect(frame.locator('#action-status')).toContainText('could not save the preference');
  frame = await open(page, 'setup=missing');
  const callout = frame.locator('#view-live > .connection-diagnosis');
  await expect(callout).toContainText('isn’t answering');
  await expect(frame.locator('.machine-summary')).toBeVisible();
  await callout.getByRole('button', { name: 'Connection…' }).click();
  await expect(frame.getByLabel('Connection', { exact: true })).toBeFocused();
});

test('switching while paused keeps the pause and discards the previous connection\'s readings', async ({ page }) => {
  const frame = await open(page, 'bionic=idle');
  await choose(page, 'bionic');
  await expect(frame.locator('#reply-strip')).toContainText('38.6');
  await frame.locator('#pause').click();
  const before = await page.evaluate(() => (window as W).previewRequests);
  await choose(page, 'studio');
  await expect(frame.locator('#pause')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => (window as W).previewRequests)).toBe(before);
  await frame.locator('#pause').click();
  await expect(frame.locator('#connection')).toHaveText('LM Studio local');
  await expect(frame.locator('#reply-strip')).toHaveCount(0);
});

test('a late response from the previous connection cannot repaint its readings', async ({ page }) => {
  const frame = await open(page);
  await page.evaluate(() => { (window as W).previewDelay = true; });
  await menu(frame, '#refresh');
  await expect.poll(() => page.evaluate(() => (window as W).previewDeferred.length)).toBe(1);
  await choose(page, 'studio');
  await page.evaluate(() => { (window as W).previewDelay = false; (window as W).previewDeferred.splice(0).forEach((reply: () => void) => reply()); });
  await expect(frame.locator('#connection')).toHaveText('LM Studio local');
  await expect(frame.locator('#prefill-progress')).toHaveCount(0);
});

test('an automatic discovery that lands on another runtime clears the previous one\'s last reply', async ({ page }) => {
  const frame = await open(page, 'bionic=idle');
  await page.evaluate(() => { (window as W).previewAutoProvider = 'bionic'; });
  await menu(frame, '#refresh');
  await expect(frame.locator('#reply-strip')).toContainText('38.6');
  await page.evaluate(() => { (window as W).previewAutoProvider = 'studio'; });
  await menu(frame, '#refresh');
  await expect(frame.locator('#connection')).toHaveText('LM Studio local');
  await expect(frame.locator('#reply-strip')).toHaveCount(0);
});

test('detailed vllm-mlx readings keep the prefill progress and its runtime estimate', async ({ page }) => {
  const frame = await open(page, 'vllm=live');
  await choose(page, 'vllm');
  await expect(frame.locator('#connection')).toHaveText('vllm-mlx local');
  await expect(frame.locator('#prefill-percent')).toHaveText('64%');
  await expect(frame.locator('#prefill-progress')).toContainText('Runtime estimate · may change');
});
