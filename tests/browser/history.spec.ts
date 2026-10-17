import { expect, test, type Page } from '@playwright/test';

// ui-history (Stage 8/10): every History state of the approved mock, on the real view (tests/browser/history.html +
// history-entry.ts), at 320/430 px in both themes and the page at 1,160 px. The checks are the mock's own
// (docs/design/shoot-2.0-mock.mjs): no overflow, text ≥ 10 px at ≥ 4.5:1, two-layer chips and bases,
// ⓘ targets, charts with a summary, no tooltip-only text. Screenshots are attached for review, not compared (pixels are
// macOS-only goldens, Stage 12).
test.use({ timezoneId: 'UTC', locale: 'en-US' });

type Harness = { now: number; copied: string; composed: string; retention: number[]; paused: boolean[]; cleared: number; trendReads: number[];
  usageReads: string[]; autoLabel: boolean[]; ledgerState: string; push(snapshot: unknown): void; snapshot: unknown };
const harness = <T>(page: Page, read: (h: Harness) => T): Promise<T> => page.evaluate(read as never, undefined) as Promise<T>;
const read = (page: Page, key: keyof Harness) => page.evaluate(k => (window as unknown as { harness: Record<string, unknown> }).harness[k], key);
const open = async (page: Page, query: string, width = 320) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/history.html?${query}`);
  await expect(page.locator('body[data-ready="true"]')).toBeVisible();
  return errors;
};
const reveal = async (page: Page, ...selectors: string[]) => {
  for (const selector of selectors) {
    const details = page.locator(selector);
    if (!(await details.evaluate(el => (el as HTMLDetailsElement).open))) await details.locator(':scope > summary').click();
  }
};
const shot = async (page: Page, name: string) => test.info().attach(name, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

/** The mock checker's rules (shoot-2.0-mock.mjs `inspect`), minus the review-board parts. */
const inspect = (page: Page, openAll = false): Promise<string[]> => page.evaluate(openAll => {
  const vw = innerWidth, problems: string[] = [];
  const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  if (openAll) document.querySelectorAll<HTMLElement>('button.info[aria-controls]').forEach(b => { b.setAttribute('aria-expanded', 'true'); document.getElementById(b.getAttribute('aria-controls')!)!.hidden = false; });
  if (document.documentElement.scrollWidth > vw) problems.push(`page scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);
  const clips = (el: Element) => { for (let a = el.parentElement; a; a = a.parentElement) if (getComputedStyle(a).overflowX !== 'visible') return a; return null; };
  document.querySelectorAll('body *').forEach(el => {
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= vw + .5) return;
    const c = clips(el);
    if (c && c.getBoundingClientRect().right <= vw + .5) return;
    problems.push(`overflow: <${el.tagName.toLowerCase()}> right ${Math.round(r.right)} > ${vw}`);
  });
  const parse = (str: string): number[] | null => { let m = /^rgba?\(([^)]+)\)$/.exec(str); if (m) { const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0]! / 255, p[1]! / 255, p[2]! / 255, p[3] ?? 1]; }
    m = /^color\(srgb ([^)]+)\)$/.exec(str); if (m) { const p = m[1]!.split(/[\s/]+/).filter(Boolean).map(Number); return [p[0]!, p[1]!, p[2]!, p[3] ?? 1]; } return null; };
  const over = (top: number[], base: number[]) => [0, 1, 2].map(i => top[i]! * top[3]! + base[i]! * (1 - top[3]!));
  const lum = (c: number[]) => { const f = (v: number) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; return .2126 * f(c[0]!) + .7152 * f(c[1]!) + .0722 * f(c[2]!); };
  const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const behind = (el: Element) => {
    const chain: Element[] = []; for (let a: Element | null = el; a; a = a.parentElement) chain.unshift(a);
    let base = [1, 1, 1];
    for (const a of chain) { const cs = getComputedStyle(a), img = /(rgba?\([^)]*\)|color\(srgb[^)]*\))/.exec(cs.backgroundImage);
      if (img && !/repeating/.test(cs.backgroundImage)) { const c = parse(img[1]!); if (c) base = over(c, base); }
      const c = parse(cs.backgroundColor); if (c) base = over(c, base); }
    return base;
  };
  document.querySelectorAll<HTMLElement>('#views *').forEach(el => {
    if (!visible(el) || el.closest('.sr-only, svg') || (el as HTMLButtonElement).disabled || el.closest('[aria-hidden="true"]')) return;
    const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    if (!own || /^[\s·•—–\-→›┊|:()+%]*$/.test(own)) return;
    const cs = getComputedStyle(el), size = parseFloat(cs.fontSize);
    if (size < 10) problems.push(`text under 10 px (${size.toFixed(2)}): "${own.slice(0, 30)}"`);
    let alpha = 1; for (let a: HTMLElement | null = el; a; a = a.parentElement) alpha *= Number(getComputedStyle(a).opacity);
    const fg = parse(cs.color); if (!fg) return;
    const bg = behind(el), cr = ratio(over([fg[0]!, fg[1]!, fg[2]!, fg[3]! * alpha], bg), bg);
    const rgb = (c: number[]) => `rgb(${c.slice(0, 3).map(v => Math.round(v * 255)).join(' ')})`;
    if (cr < 4.5 && !(size >= 18.66 || (size >= 14 && Number(cs.fontWeight) >= 700))) problems.push(`contrast ${cr.toFixed(2)}:1 for "${own.slice(0, 30)}" (${cs.color} × ${alpha.toFixed(2)} on ${rgb(bg)})`);
  });
  if (openAll) return problems;
  const text = document.body.innerText;
  if (/vram/i.test(text)) problems.push('says VRAM');
  // Two layers: a reply is "This chat" only when Scope matched it; otherwise "Engine", which keeps its reason for the
  // explanation rather than in the chip.
  document.querySelectorAll<HTMLElement>('.chip[data-attr]').forEach(chip => {
    if (!visible(chip)) return;
    const t = chip.textContent!.trim(), attr = chip.dataset.attr;
    if (!(attr === 'inferred' && t === 'This chat' || attr === 'server' && t === 'Engine' && !!chip.dataset.reason))
      problems.push(`attribution chip "${t}" (${attr}) is not This chat or Engine with its reason`);
    if (chip.scrollWidth > chip.clientWidth + 1) problems.push(`attribution chip truncated: "${t}"`);
  });
  document.querySelectorAll<HTMLElement>('[data-basis]:not([data-basis="reported"])').forEach(el => {
    if (!visible(el) || el.classList.contains('chip')) return;
    const label = el.querySelector('.basis');
    if (!label?.textContent?.trim()) problems.push(`value without basis label: "${el.textContent!.trim().slice(0, 40)}"`);
  });
  document.querySelectorAll<HTMLElement>('.led-main > .val').forEach(el => { if (!el.dataset.basis) problems.push(`value without a declared basis: "${el.textContent!.trim().slice(0, 30)}"`); });
  document.querySelectorAll('.led-main').forEach(el => { if (/token-weighted/.test((el as HTMLElement).innerText) && !el.querySelector('[data-basis="derived"]')) problems.push('token-weighted rate not marked derived'); });
  document.querySelectorAll<HTMLElement>('.view').forEach(v => {
    if (!visible(v)) return;
    const top = Array.from(v.querySelectorAll(':scope > * > .connection-diagnosis, :scope > .connection-diagnosis')).filter(visible);
    if (top.length > 1) problems.push(`${top.length} callouts stacked in one view`);
    const parts: string[] = [], walker = document.createTreeWalker(v, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (visible(n.parentElement!) && !n.parentElement!.closest('li, .sr-only, [aria-hidden="true"]')) parts.push(n.textContent!);
    const nums = parts.join(' ').match(/(?<![\d.,:])(?:\d{1,3}(?:,\d{3})+|\d+\.\d+)(?![\d.,])(?:\s?(?:K|M|%|GiB|MiB|KiB|W|tok\/s)(?![A-Za-z]))?/g) ?? [], seen: Record<string, number> = {};
    for (const n of nums) seen[n] = (seen[n] ?? 0) + 1;
    for (const [n, c] of Object.entries(seen)) if (c > 1) problems.push(`"${n}" appears ${c} times in one view`);
  });
  document.querySelectorAll('.info').forEach(b => {
    if (!visible(b)) return;
    const r = b.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) problems.push(`ⓘ target ${r.width}×${r.height} px`);
    if (!b.hasAttribute('aria-expanded') || !document.getElementById(b.getAttribute('aria-controls')!)) problems.push('ⓘ without aria-expanded/aria-controls target');
  });
  document.querySelectorAll<HTMLElement>('[title]').forEach(el => problems.push(`tooltip-only text on <${el.tagName.toLowerCase()}>: "${el.title.slice(0, 30)}"`));
  document.querySelectorAll('.plot, .usage-bars').forEach(c => { if (c.getAttribute('role') !== 'img' || !c.getAttribute('aria-label')) problems.push(`chart without role="img" and a summary: ${c.className}`); });
  document.querySelectorAll('#views svg').forEach(svg => { if (!svg.closest('[role="img"][aria-label], button') && svg.getAttribute('aria-hidden') !== 'true') problems.push('unlabelled svg'); });
  document.querySelectorAll<HTMLElement>('#views button, #views select').forEach(b => { if (!visible(b)) return; const r = b.getBoundingClientRect(); if (r.height < 24 || r.width < 24) problems.push(`target ${Math.round(r.width)}×${Math.round(r.height)} px: "${b.textContent!.trim().slice(0, 20)}"`); });
  document.querySelectorAll<HTMLElement>('#views *').forEach(el => { if (visible(el) && getComputedStyle(el).textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) problems.push(`text cut off: "${el.textContent!.trim().slice(0, 40)}"`); });
  return problems;
}, openAll);
// Linux WebKit resolves the background behind cards holding a native <select> (History storage) to a
// dark colour its own screenshot does not show; contrast there is recorded, not failed. Chromium on both platforms and
// macOS WebKit still enforce it.
const clean = async (page: Page) => {
  const soft = process.platform === 'linux' && page.context().browser()?.browserType().name() === 'webkit';
  for (const openAll of [false, true]) {
    const found = await inspect(page, openAll), contrast = found.filter(p => p.startsWith('contrast '));
    if (soft && contrast.length) test.info().annotations.push({ type: 'linux-webkit-contrast', description: contrast.join('\n') });
    expect(soft ? found.filter(p => !p.startsWith('contrast ')) : found).toEqual([]);
  }
};

test.describe('History tab', () => {
  for (const theme of ['dark', 'light']) for (const width of [320, 430]) {
    test(`the mock's History at ${width} px, ${theme}: trend, replies, usual speed, oMLX usage, storage, alert log`, async ({ page }) => {
      const errors = await open(page, `tab=history&state=decode&theme=${theme}`, width);
      const view = page.locator('#panel-history');
      await expect(view.locator('.history-insights')).toHaveJSProperty('open', false);
      await expect(view.locator('.history-storage')).toHaveJSProperty('open', false);
      await reveal(page, '.history-insights', '.history-alerts', '.history-storage');
      await expect(view.locator('section h2')).toHaveText(['Trend', 'Recent replies', 'Usual speed', 'Recorded by oMLX', 'Alert log', 'Reply history']);
      await expect(view.locator('.chart-top')).toHaveText(/Generation speed · from oMLX\s*30 tok\/s/);
      await expect(view.locator('.plot')).toHaveAttribute('aria-label', /6 turns, 21\.5 to 27\.6 tokens per second; not observed from 13:24 to 13:46\./);
      await expect(view.locator('.gap-band')).toHaveText('Not observed · Scope wasn’t open');
      await expect(view.locator('.counts .chip')).toHaveText(['41 last reading', '1 gap']);
      await expect(view.locator('.led-row').first()).toContainText('Turn · 3 steps');
      await expect(view.locator('.ledger > li')).toHaveCount(6);
      await expect(view.locator('.led-row .chip[data-attr="server"]').first()).toHaveText('Engine');
      await expect(view.locator('.led-row .chip[data-attr="server"]').first()).toHaveAttribute('data-reason', 'overlap');
      await expect(view.locator('.led-row .chip[data-attr="inferred"]').first()).toHaveText('This chat');
      await expect(view.getByText('No baseline · oMLX doesn’t report it')).toBeVisible();
      await expect(view.locator('.usage-bars > div')).toHaveCount(7);
      await expect(view.locator('.storage-line')).toHaveText(/412 KiB\s*of 1\.25 MiB · 41 replies · 13 days/);
      await expect(view.locator('.alog li')).toHaveCount(4);
      await clean(page);
      await shot(page, `history-${theme}-${width}`);
      await view.getByRole('button', { name: 'Show 24 more' }).click();
      await expect(view.locator('.led-row[data-kind="gap"]')).toHaveText('Not recorded · Scope wasn’t open · 13:24–13:46');
      expect(errors).toEqual([]);
    });
  }
  test('history after a fresh upgrade: everything says why it is empty, and the hatch covers the unobserved hour', async ({ page }) => {
    await open(page, 'tab=history&state=history-empty');
    await reveal(page, '.history-insights', '.history-alerts', '.history-storage');
    const view = page.locator('#panel-history');
    await expect(view.locator('.gap-band')).toHaveCount(1);
    await expect(view.locator('.trace')).toHaveCount(0);
    await expect(view.getByText('No replies yet. Scope records a reply when it finishes while any Scope view is open.', { exact: true })).toBeVisible();
    await expect(view).not.toContainText('Captures');
    await expect(view.getByText('Needs 5 replies for this model and context size.')).toBeVisible();
    await expect(view.getByRole('button', { name: 'Copy baseline summary' })).toHaveCount(0);
    await expect(view.locator('.storage-line')).toHaveText(/2 KiB\s*of 1\.25 MiB · 0 replies · 0 days/);
    await expect(view.getByText('No alerts while Scope was open.')).toBeVisible();
    await clean(page);
    await shot(page, 'history-empty-dark-320');
  });
  test('storage full: one warning callout says what happens and what to do', async ({ page }) => {
    await open(page, 'tab=history&state=storage-full');
    const storage = page.locator('.storage');
    await expect(storage).toHaveAttribute('data-full', 'true');
    await expect(storage.locator('.connection-diagnosis[data-severity="warning"]')).toHaveText(/History is full\s*After each save Scope removes the oldest replies, so it holds 13 of your 30 days\. Shorten retention or clear to make room\./);
    await expect(storage.locator('.storage-line')).toHaveText(/1\.25 MiB\s*at the limit/);
    await clean(page);
    await shot(page, 'history-storage-full-dark-320');
  });
  test('recording paused shows its state, and Resume and Pause reach the ledger', async ({ page }) => {
    await open(page, 'tab=history&state=recording-paused');
    await reveal(page, '.history-storage');
    const storage = page.locator('.storage');
    await expect(storage.locator('.section-heading .chip[data-tone="warn"]')).toHaveText('Recording paused');
    // Keyboard activation: WebKit does not focus a button on a mouse click.
    await storage.getByRole('button', { name: 'Resume recording' }).focus();
    await page.keyboard.press('Enter');
    await expect(storage.getByRole('button', { name: 'Pause recording' })).toBeFocused();
    await expect(storage.getByRole('status')).toHaveText('Recording again.');
    await storage.getByRole('button', { name: 'Pause recording' }).click();
    expect(await read(page, 'paused')).toEqual([false, true]);
    await clean(page);
  });
  test('a stored pause shows while the ledger is stopped (the page before its first poll, or a frame that doesn’t lead)', async ({ page }) => {
    await open(page, 'surface=page&state=recording-paused&stopped', 1160);
    await expect(page.locator('.history-storage > summary')).toContainText('Recording paused');
    await page.locator('.history-storage > summary').click();
    const storage = page.locator('.storage');
    await expect(storage.locator('.section-heading .chip[data-tone="warn"]')).toHaveText('Recording paused');
    await storage.getByRole('button', { name: 'Resume recording' }).click();
    expect(await read(page, 'paused')).toEqual([false]);
  });
  test('a view mounted on a stopped ledger follows the ledger once it runs (another frame resumed recording meanwhile)', async ({ page }) => {
    await open(page, 'tab=history&state=recording-paused&stopped');
    await reveal(page, '.history-storage');
    const storage = page.locator('.storage');
    await expect(storage.locator('.section-heading .chip[data-tone="warn"]')).toHaveText('Recording paused');
    // This frame starts leading: its ledger re-read pref.v2, which another frame set back to recording.
    await page.evaluate(() => { const h = (window as unknown as { harness: Harness }).harness; h.ledgerState = 'idle'; h.push(h.snapshot); });
    await expect(storage.getByRole('button', { name: 'Pause recording' })).toBeVisible();
    await expect(storage.locator('.section-heading .chip[data-tone="warn"]')).toHaveCount(0);
    // And back: a running ledger that turns paused shows it on the next update.
    await page.evaluate(() => { const h = (window as unknown as { harness: Harness }).harness; h.ledgerState = 'paused'; h.push(h.snapshot); });
    await expect(storage.getByRole('button', { name: 'Resume recording' })).toBeVisible();
  });
  test('Clear asks first: focus moves to Cancel, Escape backs out, Clear history empties the list', async ({ page }) => {
    await open(page, 'tab=history&state=clear-confirm');
    await reveal(page, '.history-storage');
    const storage = page.locator('.storage');
    await storage.getByRole('button', { name: 'Clear…' }).click();
    const dialog = storage.getByRole('alertdialog', { name: 'Clear 41 replies and the baselines built from them?' });
    await expect(dialog).toHaveAttribute('data-severity', 'critical');
    await expect(dialog.locator('.diag-meta')).toHaveText('This can’t be undone.');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await clean(page);
    await shot(page, 'history-clear-confirm-dark-320');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(storage.getByRole('button', { name: 'Clear…' })).toBeFocused();
    expect(await read(page, 'cleared')).toBe(0);
    await storage.getByRole('button', { name: 'Clear…' }).click();
    await storage.getByRole('button', { name: 'Clear history' }).click();
    await expect(page.getByText('No replies yet.', { exact: false })).toBeVisible();
    await expect(storage.getByRole('status')).toHaveText('Reply history and baselines cleared.');
    expect(await read(page, 'cleared')).toBe(1);
  });
  test('trend windows and usage ranges read their own data; the pressed state follows', async ({ page }) => {
    await open(page, 'tab=history&state=decode', 430);
    await page.getByRole('group', { name: 'Trend window' }).getByRole('button', { name: '15 min' }).click();
    await expect(page.getByRole('button', { name: '15 min' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('figcaption')).toContainText('−15 min');
    expect(await read(page, 'trendReads')).toEqual([3_600_000, 900_000]);
    await reveal(page, '.history-insights');
    await page.getByRole('group', { name: 'Usage range' }).getByRole('button', { name: '30d' }).click();
    await expect(page.locator('.usage-bars > div')).toHaveCount(30);
    await expect(page.locator('.usage-bars')).toHaveAttribute('data-dense', '');
    expect(await read(page, 'usageReads')).toEqual(['7d', '30d']);
    await clean(page);
  });
  test('Copy baseline summary aliases models; retention reaches the ledger; Show more pages the list', async ({ page }) => {
    await open(page, 'tab=history&state=decode');
    await reveal(page, '.history-insights', '.history-storage');
    await page.getByRole('button', { name: 'Copy baseline summary' }).click();
    await expect(page.getByText('Baseline summary copied, with models as “Model A, B”.')).toBeVisible();
    const copied = await read(page, 'copied') as string;
    expect(copied).toContain('Model A · oMLX · 32–64K context · Generation speed: typical 25.9 tok/s · 90% at or below 27.2 tok/s · 33 replies');
    expect(copied).not.toMatch(/Example-|canary/);
    await page.getByLabel('Keep reply history for').selectOption('60');
    await expect(page.getByText('Keeping 60 days. Older replies go at the next save.')).toBeVisible();
    await expect(page.getByLabel('Keep reply history for')).toHaveValue('60');
    expect(await read(page, 'retention')).toEqual([60]);
    await page.getByRole('button', { name: 'Show 24 more' }).click();
    await expect(page.locator('.ledger > li')).toHaveCount(30);
  });
  test('an open ⓘ and the focused control survive the next poll', async ({ page }) => {
    await open(page, 'tab=history&state=decode');
    await reveal(page, '.history-insights');
    const info = page.getByRole('button', { name: 'About Usual speed' });
    await info.focus();
    await page.keyboard.press('Enter');
    await expect(info).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('note').filter({ hasText: 'Typical values need 5 replies; fast and slow cutoffs need 10' })).toBeVisible();
    // A poll a minute later re-renders the whole view (clock labels move); the tree is patched, not replaced.
    await page.evaluate(() => { const h = (window as unknown as { harness: Harness }).harness; h.now += 60_000; h.push(h.snapshot); });
    await expect(page.locator('.pop').filter({ hasText: 'Refreshed' })).toContainText('Refreshed 4 min ago');
    await expect(info).toHaveAttribute('aria-expanded', 'true');
    await expect(info).toBeFocused();
  });
  test('History fills the page at 1,160 px with secondary details collapsed', async ({ page }) => {
    await open(page, 'surface=page&state=decode&theme=dark', 1160);
    const column = page.locator('#history-column');
    await expect(column.locator('.col-title')).toHaveCount(0);
    await expect(column.locator(':scope > .view-host > section h2')).toHaveText(['Trend', 'Recent replies']);
    await expect(column.locator('.history-insights')).toHaveJSProperty('open', false);
    await expect(column.locator('.history-insights h2')).toHaveText(['Usual speed', 'Recorded by oMLX']);
    await expect(column.locator('.recent-replies .section-heading')).toContainText('Recorded while Scope was open');
    await expect(column.locator('.ledger > li')).toHaveCount(6);
    await expect(column.locator('.history-alerts')).toHaveJSProperty('open', false);
    await expect(column.locator('.history-storage')).toHaveJSProperty('open', false);
    await expect(column.locator('.history-storage > summary')).toHaveText('History storageStored on this Mac');
    await expect(column.getByRole('button', { name: 'Clear…' })).toBeHidden();
    await expect(column.locator('figcaption')).toHaveText(/−60 min\s*Reply times from OpenChamber · all server activity\s*now/);
    expect((await column.locator('.trend .plot').boundingBox())!.height).toBe(132);
    await clean(page);
    await shot(page, 'history-page-dark-1160');
    await column.getByRole('button', { name: 'Show 24 more' }).click();
    await expect(column.locator('.ledger > li')).toHaveCount(30);
  });
  test('page storage opens by keyboard, preserves focus across polls, and keeps its controls working', async ({ page }) => {
    await open(page, 'surface=page&state=decode', 1160);
    const insights = page.locator('.history-insights');
    await insights.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(insights).toHaveJSProperty('open', true);
    await insights.getByRole('button', { name: 'Copy baseline summary' }).focus();
    await page.evaluate(() => { const h = (window as unknown as { harness: Harness }).harness; h.now += 60_000; h.push(h.snapshot); });
    await expect(insights).toHaveJSProperty('open', true);
    await expect(insights.getByRole('button', { name: 'Copy baseline summary' })).toBeFocused();
    const disclosure = page.locator('.history-storage');
    await disclosure.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(disclosure).toHaveJSProperty('open', true);
    const retention = disclosure.getByRole('combobox', { name: 'Keep reply history for' });
    await retention.selectOption('7');
    expect(await read(page, 'retention')).toEqual([7]);
    await retention.focus();
    await page.evaluate(() => { const h = (window as unknown as { harness: Harness }).harness; h.now += 60_000; h.push(h.snapshot); });
    await expect(disclosure).toHaveJSProperty('open', true);
    await expect(retention).toBeFocused();
    await disclosure.getByRole('button', { name: 'Clear…' }).click();
    await expect(disclosure.getByRole('alertdialog')).toBeVisible();
    await expect(disclosure.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(disclosure.getByRole('button', { name: 'Clear…' })).toBeFocused();
    await disclosure.locator('summary').click();
    await page.evaluate(() => { const h = (window as unknown as { harness: Harness }).harness; h.now += 60_000; h.push(h.snapshot); });
    await expect(disclosure).toHaveJSProperty('open', false);
  });
  test('page storage opens automatically for full storage and failed-save notices', async ({ page }) => {
    await open(page, 'surface=page&state=storage-full', 1160);
    await expect(page.locator('.history-storage')).toHaveJSProperty('open', true);
    await expect(page.locator('.history-storage > summary')).toContainText('Needs attention');
    await expect(page.getByText('History is full', { exact: true })).toBeVisible();
    await open(page, 'surface=page&state=decode', 1160);
    await page.evaluate(() => { const h = (window as unknown as { harness: Harness }).harness; h.ledgerState = 'backoff'; h.now += 60_000; h.push(h.snapshot); });
    await expect(page.locator('.history-storage')).toHaveJSProperty('open', true);
    await expect(page.locator('.storage .notice')).toContainText('OpenChamber didn’t accept the last save');
    await expect(page.locator('.storage .notice')).toBeVisible();
  });
});

test.describe('History storage from earlier versions', () => {
  test('saved items from earlier versions are counted, kept by Clear, and never listed', async ({ page }) => {
    await open(page, 'tab=history&state=clear-confirm&kept=1');
    await reveal(page, '.history-storage');
    const storage = page.locator('.storage');
    await expect(storage.getByText('Kept from earlier versions: 3 items · 18 KiB', { exact: true })).toBeVisible();
    await expect(page.locator('#views')).not.toContainText(/Captures|Next reply|Measure/);
    await clean(page);
    await storage.getByRole('button', { name: 'Clear…' }).click();
    await expect(storage.getByRole('alertdialog').locator('.diag-meta')).toHaveText('This can’t be undone. Items kept from earlier versions stay.');
    await storage.getByRole('button', { name: 'Clear history' }).click();
    await expect(storage.getByRole('status')).toHaveText('Reply history and baselines cleared.');
    expect(await read(page, 'cleared')).toBe(1);
    await open(page, 'tab=history&state=decode');
    await reveal(page, '.history-storage');
    await expect(page.locator('.storage')).not.toContainText('Kept from earlier versions');
  });
  test('the automatic chat label preference is a labelled checkbox that reaches the preference and keeps focus', async ({ page }) => {
    await open(page, 'tab=history&state=decode');
    await reveal(page, '.history-storage');
    const storage = page.locator('.storage');
    const label = storage.getByRole('checkbox', { name: 'Label replies to this chat automatically' });
    await expect(label).toBeChecked();
    await expect(label).toHaveAttribute('data-action', 'auto-label');
    await label.focus();
    await page.keyboard.press('Space');
    await expect(storage.getByRole('status')).toHaveText('New replies stay labelled Engine.');
    await expect(label).not.toBeChecked();
    await expect(label).toBeFocused();
    await label.click();
    await expect(storage.getByRole('status')).toHaveText('New replies are matched to this chat when Scope can prove it.');
    await expect(label).toBeChecked();
    expect(await read(page, 'autoLabel')).toEqual([false, true]);
    await clean(page);
    await open(page, 'tab=history&state=decode&autoLabel=off');
    await reveal(page, '.history-storage');
    await expect(page.getByRole('checkbox', { name: 'Label replies to this chat automatically' })).not.toBeChecked();
    await open(page, 'tab=history&state=decode&autoLabel=fail');
    await reveal(page, '.history-storage');
    await page.getByRole('checkbox', { name: 'Label replies to this chat automatically' }).click();
    await expect(page.locator('.storage').getByRole('status')).toHaveText('Changed here; this host could not save the preference.');
    expect(await read(page, 'autoLabel')).toEqual([]);
  });
});
