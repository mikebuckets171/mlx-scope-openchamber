import { expect, test, type Page } from '@playwright/test';

// ui-history (Stage 8/10): every History and Captures state of the approved mock, on the real views
// (tests/browser/history.html + history-entry.ts), at 320/430 px in both themes and the page at 1,160 px. The checks are
// the mock's own (docs/design/shoot-2.0-mock.mjs): no overflow, text ≥ 10 px at ≥ 4.5:1, labelled chips and bases,
// ⓘ targets, charts with a summary, no tooltip-only text. Screenshots are attached for review, not compared (pixels are
// macOS-only goldens, Stage 12).
test.use({ timezoneId: 'UTC', locale: 'en-US' });

type Harness = { now: number; copied: string; composed: string; watched: number; retention: number[]; paused: boolean[]; cleared: number; trendReads: number[];
  usageReads: string[]; saved: Array<Record<string, unknown>>; decode(ms: number, tokens: number): void; setNext(next: unknown): void; push(snapshot: unknown): void; snapshot: unknown };
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
    if (cr < 4.5 && !(size >= 18.66 || (size >= 14 && Number(cs.fontWeight) >= 700))) problems.push(`contrast ${cr.toFixed(2)}:1 for "${own.slice(0, 30)}"`);
  });
  if (openAll) return problems;
  const text = document.body.innerText;
  if (/vram/i.test(text)) problems.push('says VRAM');
  document.querySelectorAll<HTMLElement>('.chip[data-attr]').forEach(chip => {
    if (!visible(chip)) return;
    const t = chip.textContent!.trim();
    if (!/^(This chat · inferred|Next reply · armed|Server-wide · .+)$/.test(t)) problems.push(`attribution chip "${t}" (server-wide needs its reason)`);
    if (chip.scrollWidth > chip.clientWidth + 1) problems.push(`attribution chip truncated: "${t}"`);
  });
  if (/This chat(?! · inferred| uses)/.test(text) && !/this chat, then|in this chat|this chat’s/i.test(text.replace(/This chat · inferred/g, ''))) problems.push('"This chat" without "inferred"');
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
const clean = async (page: Page) => { expect(await inspect(page)).toEqual([]); expect(await inspect(page, true)).toEqual([]); };

test.describe('History tab', () => {
  for (const theme of ['dark', 'light']) for (const width of [320, 430]) {
    test(`the mock's History at ${width} px, ${theme}: trend, replies, usual speed, oMLX usage, storage, alert log`, async ({ page }) => {
      const errors = await open(page, `tab=history&state=decode&theme=${theme}`, width);
      const view = page.locator('#panel-history');
      await expect(view.locator('section h2')).toHaveText(['Trend', 'Replies', 'Usual speed', 'Recorded by oMLX', 'Reply history', 'Alert log']);
      await expect(view.locator('.chart-top')).toHaveText(/Decode speed · reported by oMLX\s*30 tok\/s/);
      await expect(view.locator('.plot')).toHaveAttribute('aria-label', /6 turns, 21\.5 to 27\.6 tokens per second; not observed from 13:24 to 13:46\./);
      await expect(view.locator('.gap-band')).toHaveText('Not observed · Scope wasn’t open');
      await expect(view.locator('.counts .chip')).toHaveText(['41 last observed', '1 gap']);
      await expect(view.locator('.led-row').first()).toContainText('Turn · 3 steps');
      await expect(view.locator('.led-row[data-kind="gap"]')).toHaveText('Not observed · Scope wasn’t open · 13:24–13:46');
      await expect(view.locator('.led-row .chip[data-attr="server"]').first()).toHaveText('Server-wide · overlapping requests');
      await expect(view.getByText('No baseline · oMLX doesn’t report it')).toBeVisible();
      await expect(view.locator('.usage-bars > div')).toHaveCount(7);
      await expect(view.locator('.storage-line')).toHaveText(/412 KiB\s*of 1\.25 MiB · 41 replies · 13 days/);
      await expect(view.locator('.alog li')).toHaveCount(4);
      await clean(page);
      await shot(page, `history-${theme}-${width}`);
      expect(errors).toEqual([]);
    });
  }
  test('history after a fresh upgrade: everything says why it is empty, and the hatch covers the unobserved hour', async ({ page }) => {
    await open(page, 'tab=history&state=history-empty');
    const view = page.locator('#panel-history');
    await expect(view.locator('.gap-band')).toHaveCount(1);
    await expect(view.locator('.trace')).toHaveCount(0);
    await expect(view.getByText('No replies yet. Scope records a reply when it finishes while any Scope view is open. Your 1.6 captures are in Captures.')).toBeVisible();
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
  test('Clear asks first: focus moves to Cancel, Escape backs out, Clear history empties the list and keeps captures', async ({ page }) => {
    await open(page, 'tab=history&state=clear-confirm');
    const storage = page.locator('.storage');
    await storage.getByRole('button', { name: 'Clear…' }).click();
    const dialog = storage.getByRole('alertdialog', { name: 'Clear 41 replies and the baselines built from them?' });
    await expect(dialog).toHaveAttribute('data-severity', 'critical');
    await expect(dialog).toContainText('This can’t be undone. Captures are kept.');
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
    await expect(storage.getByRole('status')).toHaveText('Reply history and baselines cleared. Captures were kept.');
    expect(await read(page, 'cleared')).toBe(1);
  });
  test('trend windows and usage ranges read their own data; the pressed state follows', async ({ page }) => {
    await open(page, 'tab=history&state=decode', 430);
    await page.getByRole('group', { name: 'Trend window' }).getByRole('button', { name: '15 min' }).click();
    await expect(page.getByRole('button', { name: '15 min' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('figcaption')).toContainText('−15 min');
    expect(await read(page, 'trendReads')).toEqual([3_600_000, 900_000]);
    await page.getByRole('group', { name: 'Usage range' }).getByRole('button', { name: '30d' }).click();
    await expect(page.locator('.usage-bars > div')).toHaveCount(30);
    await expect(page.locator('.usage-bars')).toHaveAttribute('data-dense', '');
    expect(await read(page, 'usageReads')).toEqual(['7d', '30d']);
    await clean(page);
  });
  test('Copy baseline summary aliases models; retention reaches the ledger; Show more pages the list', async ({ page }) => {
    await open(page, 'tab=history&state=decode');
    await page.getByRole('button', { name: 'Copy baseline summary' }).click();
    await expect(page.getByText('Baseline summary copied, with models as “Model A, B”.')).toBeVisible();
    const copied = await read(page, 'copied') as string;
    expect(copied).toContain('Model A · oMLX · 32–64K context · decode: p50 25.9 tok/s · p90 27.2 tok/s · n 33');
    expect(copied).not.toMatch(/Example-|canary/);
    await page.getByLabel('Keep reply history for').selectOption('60');
    await expect(page.getByText('Keeping 60 days. Older replies go at the next save.')).toBeVisible();
    await expect(page.getByLabel('Keep reply history for')).toHaveValue('60');
    expect(await read(page, 'retention')).toEqual([60]);
    await page.getByRole('button', { name: 'Show 24 more' }).click();
    await expect(page.locator('.ledger > li')).toHaveCount(36);
  });
  test('an open ⓘ and the focused control survive the next poll', async ({ page }) => {
    await open(page, 'tab=history&state=decode');
    const info = page.getByRole('button', { name: 'About Usual speed' });
    await info.focus();
    await page.keyboard.press('Enter');
    await expect(info).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('note').filter({ hasText: 'p50 needs 5 replies and p90 needs 10' })).toBeVisible();
    // A poll a minute later re-renders the whole view (clock labels move); the tree is patched, not replaced.
    await page.evaluate(() => { const h = (window as unknown as { harness: Harness }).harness; h.now += 60_000; h.push(h.snapshot); });
    await expect(page.locator('.pop').filter({ hasText: 'Refreshed' })).toContainText('Refreshed 4 min ago');
    await expect(info).toHaveAttribute('aria-expanded', 'true');
    await expect(info).toBeFocused();
  });
  test('the page’s History column at 1,160 px', async ({ page }) => {
    await open(page, 'surface=page&state=decode&theme=dark', 1160);
    const column = page.locator('#history-column');
    await expect(column.locator('.col-title')).toHaveText(/History\s*Observed while Scope was open · stored on this Mac/);
    await expect(column.locator('figcaption')).toHaveText(/−60 min\s*Turn times from OpenChamber · readings are server-wide\s*now/);
    expect((await column.locator('.trend .plot').boundingBox())!.height).toBe(132);
    await clean(page);
    await shot(page, 'history-page-dark-1160');
  });
});

test.describe('Captures tab', () => {
  for (const theme of ['dark', 'light']) for (const width of [320, 430]) {
    test(`the mock's Captures at ${width} px, ${theme}: Next reply, window, saved`, async ({ page }) => {
      const errors = await open(page, `tab=captures&state=decode&theme=${theme}`, width);
      const view = page.locator('#panel-captures');
      await expect(view.locator('h2')).toHaveText(['Next reply', 'Window', 'Saved']);
      await expect(view.getByRole('button', { name: 'Measure next reply' })).toHaveClass(/primary/);
      await expect(view.locator('.chip[data-attr="armed"]')).toHaveCount(1);   // only the saved Next reply, nothing armed
      await expect(view.getByText('Monitoring keeps running while you capture.')).toBeVisible();
      await expect(view.locator('.section-heading').nth(2)).toContainText('3 of 12 · oldest replaced when full');
      await expect(view.locator('.ledger .led-main > span:not(.val):not(.chip)')).toHaveText(['Next reply · oMLX', 'Window 60 s · oMLX', 'Window 30 s · oMLX']);
      await expect(view.getByRole('button', { name: 'Add to chat draft' })).toBeDisabled();
      await expect(view).not.toContainText('Example-');
      await clean(page);
      await shot(page, `captures-${theme}-${width}`);
      expect(errors).toEqual([]);
    });
  }
  test('Next reply arms, counts down on its own clock, and cancels', async ({ page }) => {
    await open(page, 'tab=captures&state=next-armed');
    const card = page.locator('[data-next]');
    await expect(card.locator('.section-heading .chip[data-attr="armed"]')).toHaveText('Next reply · armed');
    await expect(card.locator('.actions')).toContainText('1:48 left');
    await clean(page);
    await shot(page, 'captures-next-armed-dark-320');
    await page.evaluate(() => { (window as unknown as { harness: Harness }).harness.now += 5_000; });
    await expect(card.locator('.actions')).toContainText('1:43 left', { timeout: 3_000 });
    await card.getByRole('button', { name: 'Cancel' }).click();
    await expect(card).toHaveAttribute('data-next', 'cancelled');
    await expect(card).toContainText('Cancelled.');
    await card.getByRole('button', { name: 'Measure next reply' }).click();
    await expect(card).toHaveAttribute('data-next', 'armed');
    await expect(card.locator('.actions')).toContainText('2:00 left');
  });
  test('measuring shows one pulse, the elapsed time and no numbers from the reply', async ({ page }) => {
    await open(page, 'tab=captures&state=next-measuring');
    const card = page.locator('[data-next]');
    await expect(card.locator('.pulse')).toHaveCount(1);
    await expect(card.getByRole('status')).toHaveText('Measuring next reply · 38 s');
    await expect(card).not.toContainText('tok/s');
    await clean(page);
  });
  test('a result is saved once, as numbers and a runtime kind, and joins the saved list', async ({ page }) => {
    await open(page, 'tab=captures&state=next-result');
    const card = page.locator('[data-next]');
    await expect(card.locator('.reply-head')).toHaveText(/Last reply\s*Next reply · armed\s*9 s ago/);
    await expect(card.locator('.reply-values')).toHaveText(/25\.1 tok\/s\s*derived\s*1,204 out/);
    await expect(card.locator('.split')).toHaveText(/Turn 38 s\s*observed/);
    await clean(page);
    await shot(page, 'captures-next-result-dark-320');
    await card.getByRole('button', { name: 'Save to Captures' }).click();
    await expect(page.getByText('Saved to Captures without model names.')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Save to Captures' })).toHaveCount(0);
    await expect(page.locator('.section-heading').nth(2)).toContainText('4 of 12');
    const saved = await read(page, 'saved') as Array<Record<string, unknown>>;
    expect(saved[0]).toEqual(expect.objectContaining({ kind: 'next-reply', runtime: 'omlx', label: 'armed', measurements: expect.objectContaining({ outputTokens: 1204, steps: 2 }) }));
    expect(JSON.stringify(saved)).not.toMatch(/Example-|model/);
  });
  test('another runtime offers Watch instead of arming; no chat activity says so', async ({ page }) => {
    await open(page, 'tab=captures&state=other-provider');
    await page.getByRole('button', { name: 'Watch Splash' }).click();
    expect(await read(page, 'watched')).toBe(1);
    await open(page, 'tab=captures&state=decode&next=none');
    await expect(page.locator('[data-next="unavailable"]')).toContainText('Next reply needs an open chat in OpenChamber.');
    await expect(page.getByRole('button', { name: 'Measure next reply' })).toHaveCount(0);
  });
  test('a 30 s window records while monitoring runs, finishes on the service clock, and saves server-wide', async ({ page }) => {
    await open(page, 'tab=captures&state=decode', 430);
    const card = page.locator('[data-window]');
    await card.getByLabel('Window length').selectOption('30000');
    await card.getByRole('button', { name: 'Start capture' }).click();
    await expect(card).toHaveAttribute('data-window', 'recording');
    await expect(card.getByRole('progressbar', { name: 'Window' })).toBeVisible();
    await page.evaluate(() => { const h = (window as unknown as { harness: Harness }).harness; for (let i = 1; i <= 30; i += 1) h.decode(i * 500, 1000 + i * 12); });
    await expect(card.locator('.section-heading')).toContainText('15 / 30 s');
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    await page.evaluate(() => { const h = (window as unknown as { harness: Harness }).harness; for (let i = 31; i <= 60; i += 1) h.decode(i * 500, 1000 + i * 12); });
    await expect(card).toHaveAttribute('data-window', 'finished');
    await expect(card.locator('.section-heading')).toContainText('Captured · 30 s');
    await expect(card.locator('.reply-values')).toContainText('24.0 tok/s');
    await clean(page);
    await card.getByRole('button', { name: 'Save to Captures' }).click();
    await expect(card).toHaveAttribute('data-window', 'idle');
    await expect(page.locator('.ledger .led-main > span:not(.val):not(.chip)').first()).toHaveText('Window 30 s · oMLX');
    const saved = await read(page, 'saved') as Array<{ label: string; measurements: Record<string, number> }>;
    expect(saved[0]).toEqual(expect.objectContaining({ label: 'server-wide', measurements: expect.objectContaining({ windowMs: 30_000, decodeTps: 24, outputTokens: 708 }) }));
  });
  test('Compare pins a reference and shows derived deltas; Copy and Add to chat draft never carry a model name', async ({ page }) => {
    await open(page, 'tab=captures&state=decode&chat=1&legacy=1', 430);
    const rows = page.locator('.ledger').first().locator('li');
    await rows.nth(1).getByRole('button', { name: 'Compare' }).focus();
    await page.keyboard.press('Enter');
    await expect(rows.nth(1).getByRole('button', { name: 'Comparing' })).toBeFocused();
    await expect(rows.nth(0).locator('.chip[data-basis="derived"]')).toHaveText('+2% vs reference');
    await expect(rows.nth(2).locator('.chip[data-basis="derived"]')).toHaveText('+149% vs reference');
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(page.getByText('Captures copied without model names.')).toBeVisible();
    await page.getByRole('button', { name: 'Add to chat draft' }).click();
    for (const key of ['copied', 'composed'] as const) {
      const text = await read(page, key) as string;
      expect(text).toContain('MLX Scope 2.0.0 — saved captures');
      expect(text).not.toMatch(/Example-/);
    }
    await clean(page);
  });
  test('1.x captures are listed read-only in their own section', async ({ page }) => {
    await open(page, 'tab=captures&state=decode&legacy=1');
    const legacy = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Saved in 1.x' }) });
    await expect(legacy.locator('.section-heading')).toContainText('Read-only · kept until MLX Scope 2.1');
    await expect(legacy.locator('li')).toHaveCount(2);
    await expect(legacy.getByRole('button', { name: /Delete|Clear/ })).toHaveCount(0);
    await clean(page);
  });
});

test('monitoring keeps running on the saved captures tab (the 1.6 suspend is gone)', async ({ page }) => {
  await page.goto('/?state=decode');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#phase')).toHaveText('Generating');
  await frame.getByRole('tab', { name: /^(Saved|Captures)$/ }).click();
  const requests = () => page.evaluate(() => (window as unknown as { previewRequests: number }).previewRequests);
  const before = await requests();
  await expect.poll(requests, { timeout: 6_000 }).toBeGreaterThan(before + 1);
  await expect(frame.locator('main')).not.toContainText('Monitoring suspended');
});
