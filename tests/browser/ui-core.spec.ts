import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { inspect } from './ui-checks.ts';

// Stage 8 (ui-core): the 2.0 panel on the 2.0 fixture host (tests/browser/v2-host.html), which answers /v2/snapshot with
// the approved G2 mock's v2 states. Every state at 320/430/1160, the Work Status section at 280 × 24/56/80/≤ 200, and the
// mock's checks (contrast ≥ 4.5:1, targets ≥ 24 px, aria, basis labels, no overflow) on each.
type W = Window & Record<string, any>;
const STATES = ['decode', 'withheld-chats', 'withheld-subagent', 'other-provider', 'armed-refusal', 'first-readings', 'prefill', 'prefill-stall', 'idle',
  'paused', 'next-armed', 'next-measuring', 'next-result', 'splash-recovering', 'splash-stale', 'splash-not-admitting', 'offline', 'runtime-changed', 'detecting',
  'unconfigured', 'contract-mismatch', 'needs-approval', 'admin-unauthorized', 'pressure', 'pressure-critical', 'thermal', 'model-unloaded', 'memory-guard',
  'llama', 'llama-sleeping', 'llama-metrics', 'ollama', 'bionic', 'lms-unavailable', 'storage-full', 'history-empty', 'recording-paused', 'clear-confirm'];
const host = <T>(page: Page, read: (w: W) => T): Promise<T> => page.evaluate(`(${read.toString()})(window)`) as Promise<T>;
const panel = (page: Page) => page.frames().find(frame => frame !== page.mainFrame())!;
const load = async (page: Page, query: string, width = 320): Promise<FrameLocator> => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/v2?${query}`);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#scope')).toBeVisible();
  await expect.poll(() => host(page, w => w.previewRequests)).toBeGreaterThan(0);
  await expect(frame.locator('#phase')).not.toHaveText('Connecting');
  return frame;
};
const problems = async (page: Page, openAll = false) => panel(page).evaluate(inspect, openAll);
const errorsOf = (page: Page) => { const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); return errors; };

test.describe.configure({ timeout: 240_000 });

test('every mock state passes the mock\'s checks on Live and Server at 320 (dark), with every ⓘ open too', async ({ page }) => {
  const errors = errorsOf(page);
  for (const state of STATES) {
    const frame = await load(page, `state=${state}`);
    expect(await problems(page), `${state} live`).toEqual([]);
    if (await frame.locator('#tab-server').isVisible()) {
      await frame.locator('#tab-server').click();
      expect(await problems(page), `${state} server`).toEqual([]);
      await frame.locator('#tab-live').click();
    }
    expect(await problems(page, true), `${state} live, every ⓘ open`).toEqual([]);
  }
  expect(errors).toEqual([]);
});

test('every mock state passes the checks in light at 320, at 430, and on the 1,160 px page', async ({ page }) => {
  const errors = errorsOf(page);
  for (const state of STATES) for (const [query, width] of [[`theme=light&state=${state}`, 320], [`state=${state}`, 430], [`surface=page&state=${state}`, 1160],
    [`surface=page&theme=light&state=${state}`, 1160]] as const) {
    await load(page, query, width);
    expect(await problems(page), `${query} @ ${width}`).toEqual([]);
  }
  expect(errors).toEqual([]);
});

test('the page shows Live | History side by side at ≥ 900 px and the four rail tabs below it', async ({ page }) => {
  let frame = await load(page, 'surface=page&state=decode', 1160);
  await expect(frame.getByRole('tab')).toHaveText(['Live · History', 'Server', 'Captures']);
  await expect(frame.locator('#scope')).toHaveAttribute('data-layout', 'columns');
  const [live, history] = await Promise.all([frame.locator('#col-live').boundingBox(), frame.locator('#col-history').boundingBox()]);
  expect(live!.x + live!.width).toBeLessThanOrEqual(history!.x);
  expect(Math.abs(live!.y - history!.y)).toBeLessThan(2);
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(frame.getByRole('tab')).toHaveText(['Live', 'Server', 'History', 'Captures']);
  frame = await load(page, 'state=decode', 1160);
  await expect(frame.locator('#scope')).toHaveAttribute('data-layout', 'tabs');
});

test('tabs: keyboard navigation with roving tabindex, and monitoring keeps running on every tab', async ({ page }) => {
  const frame = await load(page, 'state=decode');
  await frame.getByRole('tab', { name: 'Live', exact: true }).focus();
  for (const name of ['Server', 'History', 'Captures']) {
    await page.keyboard.press('ArrowRight');
    await expect(frame.getByRole('tab', { name, exact: true })).toBeFocused();
    await expect(frame.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(frame.locator(`#panel-${name.toLowerCase()}`)).toBeVisible();
  }
  const before = await host(page, w => w.previewRequests);
  await expect.poll(() => host(page, w => w.previewRequests)).toBeGreaterThan(before + 1);
  await page.keyboard.press('Home');
  await expect(frame.getByRole('tab', { name: 'Live', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(frame.getByRole('tab', { name: 'Captures', exact: true })).toBeFocused();
  // The Server tab asks for the server-only reads (detail=server); Live does not.
  await frame.getByRole('tab', { name: 'Server', exact: true }).click();
  await expect.poll(async () => (await host(page, w => w.previewQueries)).at(-1).detail).toBe('server');
  await frame.getByRole('tab', { name: 'Live', exact: true }).click();
  await expect.poll(async () => (await host(page, w => w.previewQueries)).at(-1).detail).toBeUndefined();
});

test('ⓘ is a disclosure: one open at a time, in flow, Esc closes it and returns focus; it survives polls', async ({ page }) => {
  const frame = await load(page, 'state=decode');
  const attr = frame.locator('#attribution .info'), basis = frame.locator('.basis-line .info');
  await attr.click();
  await expect(attr).toHaveAttribute('aria-expanded', 'true');
  await expect(frame.locator('#pop-live-attr')).toBeVisible();
  await basis.click();
  await expect(frame.locator('#pop-live-attr')).toBeHidden();
  await expect(frame.locator('#pop-live-basis')).toBeVisible();
  const before = await host(page, w => w.previewRequests);
  await expect.poll(() => host(page, w => w.previewRequests)).toBeGreaterThan(before + 1);
  await expect(frame.locator('#pop-live-basis')).toBeVisible();
  await basis.focus();
  await page.keyboard.press('Escape');
  await expect(frame.locator('#pop-live-basis')).toBeHidden();
  await expect(basis).toBeFocused();
  // Mac details stay as the reader left them, and a focused control keeps focus through polls.
  await frame.locator('#mac-details > summary').click();
  await frame.locator('#mac-details > summary').focus();
  await page.waitForTimeout(1_200);
  await expect(frame.locator('#mac-details')).toHaveJSProperty('open', true);
  await expect(frame.locator('#mac-details > summary')).toBeFocused();
});

test('callouts: the most severe message first, the rest behind "N more"', async ({ page }) => {
  const frame = await load(page, 'state=pressure');
  const callout = frame.locator('#panel-live > .connection-diagnosis');
  await expect(callout).toHaveCount(1);
  await expect(callout).toHaveAttribute('data-severity', 'warning');
  await expect(callout.locator('> .diag-title strong')).toHaveText('macOS memory pressure: warning');
  await callout.getByRole('button', { name: '1 more alert' }).click();
  await expect(callout.locator('.diag-more')).toContainText('Swap grew 1.3 GiB in 4 min');
  await load(page, 'state=pressure-critical');
  await expect(page.frameLocator('iframe').locator('#panel-live > .connection-diagnosis')).toHaveAttribute('data-severity', 'critical');
  // Critical uses --scope-bad (derived from the host's error token), and only for critical.
  const tone = await page.frameLocator('iframe').locator('#panel-live > .connection-diagnosis').evaluate(el => getComputedStyle(el).getPropertyValue('--tone').trim());
  expect(tone).toMatch(/#ee8992|238, 137, 146/i);
});

test('needs approval (NO_SERVICE) and version skew replace the tabs with their S11 cards', async ({ page }) => {
  let frame = await load(page, 'state=needs-approval');
  await expect(frame.locator('#approval-card h2')).toHaveText('MLX Scope 2.0 needs one approval');
  await expect(frame.locator('#workspace-nav')).toBeHidden();
  await expect(frame.locator('#phase')).toHaveText('Needs approval');
  await expect(frame.locator('#approval-card')).not.toContainText(/sessions|project names|chat titles/i);
  frame = await load(page, 'state=contract-mismatch');
  await expect(frame.locator('#restart-card')).toContainText('The panel was updated, but its local service is still the old version.');
  await expect(frame.locator('#restart-card li')).toHaveText(['Open Settings → Extensions → MLX Scope.', 'Pause it, then resume it.']);
  await expect(frame.locator('#phase')).toHaveText('Needs restart');
});

test('Compact is the glance, at most 160 px, and Expand returns to the tabs', async ({ page }) => {
  const frame = await load(page, 'state=pressure');
  await frame.locator('#monitor-menu > summary').click();
  await frame.locator('#compact').click();
  await expect(frame.locator('#compact-glance .ws')).toBeVisible();
  await expect(frame.locator('#workspace-nav')).toBeHidden();
  expect(await frame.locator('#scope').evaluate(el => el.scrollHeight)).toBeLessThanOrEqual(160);
  await expect(frame.locator('#compact-glance .ws-alert')).toContainText('macOS memory pressure: warning');
  expect(await problems(page)).toEqual([]);
  await frame.getByRole('button', { name: 'Expand' }).click();
  await expect(frame.locator('#workspace-nav')).toBeVisible();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('view.compact'))).toBe('false');
});

const status = async (page: Page, query: string) => {
  await page.setViewportSize({ width: 300, height: 600 });
  await page.goto(`/v2?surface=status&${query}`);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#ws')).toBeVisible();
  await expect.poll(() => host(page, w => w.previewRequests)).toBeGreaterThan(0);
  return frame;
};
const lastHeight = (page: Page) => host(page, w => w.previewHeights.at(-1));

test('Work Status: 56 / 80 / 24 px glance and the one-time tip, sized with setHeight on the glance tier', async ({ page }) => {
  let frame = await status(page, 'state=decode');
  await expect.poll(() => lastHeight(page)).toBe(96);
  await expect(frame.locator('#ws .connection-diagnosis')).toHaveText('Replace Turn stats: hide it in Panel sections and drag MLX Scope into its place');
  expect((await host(page, w => w.previewQueries))[0]).toMatchObject({ surface: 'status', tier: 'glance' });
  await frame.getByRole('button', { name: 'Dismiss tip' }).click();
  await expect.poll(() => lastHeight(page)).toBe(56);
  expect(JSON.parse((await page.evaluate(() => sessionStorage.getItem('pref.v2')))!)).toMatchObject({ tipDismissed: true });
  expect(await problems(page)).toEqual([]);
  // Remembered: the next mount starts without the tip.
  frame = await status(page, 'state=pressure');
  await expect.poll(() => lastHeight(page)).toBe(80);
  await expect(frame.locator('.ws-alert')).toHaveAttribute('data-severity', 'warning');
  await expect(frame.locator('.ws-alert')).toContainText('macOS memory pressure: warning');
  expect(await problems(page)).toEqual([]);
  frame = await status(page, 'state=decode&chat=cloud');
  await expect.poll(() => lastHeight(page)).toBe(24);
  await expect(frame.locator('#ws')).toHaveText('Chat uses a non-local model');
  expect(await problems(page)).toEqual([]);
  for (const [state, height] of [['offline', 56], ['splash-recovering', 56], ['needs-approval', 56], ['prefill', 56], ['idle', 56], ['pressure-critical', 80]] as const) {
    frame = await status(page, `state=${state}`);
    await expect.poll(() => lastHeight(page), state).toBe(height);
    expect(await problems(page), state).toEqual([]);
  }
  // The host clamps the frame to what the section asked for.
  expect(await page.locator('iframe').evaluate(el => el.getBoundingClientRect().height)).toBe(80);
});

test('Work Status: every mock state in both themes at 280 px is one of the section heights and passes the checks', async ({ page }) => {
  const errors = errorsOf(page);
  for (const theme of ['dark', 'light']) for (const state of STATES) {
    await status(page, `state=${state}&theme=${theme}`);
    await expect.poll(() => lastHeight(page), `${state} ${theme}`).toBeDefined();
    expect([24, 56, 80, 96], `${state} ${theme}`).toContain(await lastHeight(page));
    expect(await problems(page), `${state} ${theme}`).toEqual([]);
  }
  expect(errors).toEqual([]);
});

test('Work Status: the Turn stats replacement stays within 200 px and its choice is kept in pref.v2', async ({ page }) => {
  await page.goto('/v2');
  await page.evaluate(() => sessionStorage.setItem('pref.v2', JSON.stringify({ tipDismissed: true })));
  let frame = await status(page, 'state=bionic&chat=local');
  await expect.poll(() => lastHeight(page)).toBe(56);
  await frame.getByRole('button', { name: 'Show turn stats' }).click();
  await expect(frame.locator('#ws')).toHaveAttribute('data-mode', 'turn-stats');
  const height = await lastHeight(page);
  expect(height).toBeGreaterThan(56);
  expect(height).toBeLessThanOrEqual(200);
  // Without a turn summary, the slot is the last reply with its own label and the rows the runtime reports.
  await expect(frame.locator('.ts-head')).toContainText('Last reply');
  expect(await frame.locator('.ts-rows dt').allTextContents()).toEqual(['Response', 'TTFT', 'Tokens in · out', 'Cache %', 'Context used']);
  expect(await frame.locator('.ts-rows dd[data-basis="reported"] .basis').count()).toBe(0);
  expect(JSON.parse((await page.evaluate(() => sessionStorage.getItem('pref.v2')))!)).toMatchObject({ statusExpanded: true, tipDismissed: true });
  expect(await problems(page)).toEqual([]);
  frame = await status(page, 'state=bionic');
  await expect(frame.locator('#ws')).toHaveAttribute('data-mode', 'turn-stats');
  await frame.getByRole('button', { name: 'Show the glance view' }).click();
  await expect.poll(() => lastHeight(page)).toBe(56);
});

test('the visibility gate engages before the first poll: a display:none frame makes zero requests', async ({ page }) => {
  await page.goto('/v2?frame=hidden&state=decode');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#scope')).toBeAttached();
  await page.waitForTimeout(1_500);
  expect(await host(page, w => w.previewRequests)).toBe(0);
  await page.evaluate(() => (window as W).setPreviewFrameHidden(false));
  await expect.poll(() => host(page, w => w.previewRequests)).toBeGreaterThan(0);
  await page.evaluate(() => (window as W).setPreviewFrameHidden(true));
  await page.waitForTimeout(400);
  const hidden = await host(page, w => w.previewRequests);
  await page.waitForTimeout(1_500);
  expect(await host(page, w => w.previewRequests)).toBe(hidden);
});

test('polls send the since cursor, and the host answers only newer completions', async ({ page }) => {
  const frame = await load(page, 'state=bionic');
  await expect.poll(async () => (await host(page, w => w.previewQueries)).length, { timeout: 10_000 }).toBeGreaterThan(2);
  const [first, ...later] = await host(page, w => w.previewQueries);
  expect(first).toMatchObject({ surface: 'panel', tier: 'full' });
  expect(first.since).toBeUndefined();
  for (const query of later) expect(query.since).toBe('23');
  // The newest reply survives polls that carry no items.
  await expect(frame.locator('#reply-strip')).toContainText('38.6');
});

test('no panel cap on the service cadence: a lower-priority frame backs off to the 10 s the service asks for', async ({ page }) => {
  await page.clock.install();
  await page.goto('/v2?state=decode&poll=10000&leader=0');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#scope')).toBeVisible();
  await expect.poll(() => host(page, w => w.previewRequests)).toBe(1);
  await page.clock.runFor(9_000);
  expect(await host(page, w => w.previewRequests)).toBe(1);
  // The no-fresh deadline is max(6 s, 2 × 10 s + 1 s): a slow cadence is not a stall.
  await expect(frame.locator('#panel-live > .connection-diagnosis')).toHaveCount(0);
  await page.clock.runFor(1_500);
  await expect.poll(() => host(page, w => w.previewRequests)).toBe(2);
});

test('a missed deadline hides the live rate and says so; the next reading restores it', async ({ page }) => {
  await page.clock.install();
  await page.goto('/v2?state=decode');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#rate')).toHaveText('26.4');
  await page.evaluate(() => { (window as W).previewHold = true; });
  await page.clock.runFor(6_600);
  await expect(frame.locator('#rate')).toHaveCount(0);
  await expect(frame.locator('#panel-live > .connection-diagnosis')).toContainText('No fresh readings');
  await expect(frame.locator('#phase')).toHaveText('Reconnecting');
  // The held request times out in the SDK (20 s); the next poll brings a reading back.
  await page.evaluate(() => { (window as W).previewHold = false; });
  await page.clock.runFor(22_000);
  await expect(frame.locator('#rate')).toHaveText('26.4');
  await expect(frame.locator('#panel-live > .connection-diagnosis')).toHaveCount(0);
});

test('badge and toast come only from the leader, once per toastSeq, and never name a model', async ({ page }) => {
  await status(page, 'state=pressure-critical&leader=1');
  await expect.poll(() => host(page, w => w.previewBadges.at(-1))).toBe(2);
  // Already up when this frame started leading: another leader toasted it.
  await page.waitForTimeout(1_000);
  expect(await host(page, w => w.previewToasts.length)).toBe(0);
  await page.evaluate(() => (window as W).setPreviewPatch({ alerts: [{ id: 'pressure-critical', severity: 'critical', since: Date.now() - 1_000, params: { level: 4 }, badge: true, toastSeq: 10 }] }));
  await expect.poll(() => host(page, w => w.previewToasts.length)).toBe(1);
  await expect.poll(() => host(page, w => w.previewBadges.at(-1))).toBe(1);
  const [toast] = await host(page, w => w.previewToasts);
  expect(toast).toMatchObject({ kind: 'error', dismiss: true, message: 'MLX Scope · macOS memory pressure: critical. Reported by the macOS kernel · replies may slow sharply until memory frees up.' });
  await page.waitForTimeout(1_500);
  expect(await host(page, w => w.previewToasts.length)).toBe(1);
  // Not the leader: nothing.
  await status(page, 'state=pressure-critical&leader=0');
  await page.evaluate(() => (window as W).setPreviewPatch({ alerts: [{ id: 'pressure-critical', severity: 'critical', since: Date.now(), params: { level: 4 }, badge: true, toastSeq: 11 }] }));
  await page.waitForTimeout(1_500);
  expect(await host(page, w => [w.previewBadges.length, w.previewToasts.length])).toEqual([0, 0]);
  // A visible rail panel clears the badge itself and never sets one; "all" toasts never carry the model name.
  await page.evaluate(() => sessionStorage.setItem('pref.v2', JSON.stringify({ toasts: 'all' })));
  await load(page, 'state=model-unloaded&leader=1');
  await page.evaluate(() => (window as W).setPreviewPatch({ alerts: [{ id: 'model-unloaded', severity: 'info', since: Date.now(), params: { model: 'Example-27B-4bit' }, badge: true, toastSeq: 12 }] }));
  await expect.poll(() => host(page, w => w.previewToasts.length)).toBe(1);
  expect(await host(page, w => w.previewBadges)).toEqual([null]);
  expect(JSON.stringify(await host(page, w => w.previewToasts))).not.toContain('Example-');
});
