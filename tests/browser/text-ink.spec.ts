import { expect, test } from '@playwright/test';

// DOM advance boxes can fit while an overflow mask cuts the actual glyph. Measure each character's
// raster-font ink, including overhangs, against real clipping ancestors; do not use scrollWidth as a proxy.
const clippedInk = (root: Element) => {
  const context = document.createElement('canvas').getContext('2d')!;
  const failures: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement!, style = getComputedStyle(parent);
    if (!parent.checkVisibility() || parent.closest('.sr-only, .digit-before') || !node.textContent?.trim()) continue;
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    context.textAlign = 'left'; context.textBaseline = 'alphabetic';
    const text = node.textContent;
    for (let offset = 0; offset < text.length; offset++) {
      if (!/[\d.A-Z%>]/.test(text[offset]!)) continue;
      const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
      const advance = range.getBoundingClientRect(), metrics = context.measureText(text[offset]!);
      if (![metrics.actualBoundingBoxLeft, metrics.actualBoundingBoxRight, metrics.actualBoundingBoxAscent, metrics.actualBoundingBoxDescent].every(Number.isFinite))
        throw new Error('The browser did not provide real glyph-ink metrics for this regression.');
      const left = advance.left - metrics.actualBoundingBoxLeft, right = advance.left + metrics.actualBoundingBoxRight;
      // Font-box metrics place the real baseline independently of the CSS line-height/overflow mask.
      const ascent = metrics.fontBoundingBoxAscent;
      const baseline = Number.isFinite(ascent) ? advance.top + ascent : null;
      const top = baseline === null ? null : baseline - metrics.actualBoundingBoxAscent;
      const bottom = baseline === null ? null : baseline + metrics.actualBoundingBoxDescent;
      for (let clip: Element | null = parent; clip && clip !== document.body && clip !== document.documentElement; clip = clip.parentElement) {
        const cs = getComputedStyle(clip), box = clip.getBoundingClientRect();
        const xClips = /^(hidden|clip|auto|scroll)$/.test(cs.overflowX), yClips = /^(hidden|clip|auto|scroll)$/.test(cs.overflowY);
        const x = box.left + parseFloat(cs.borderLeftWidth), endX = box.right - parseFloat(cs.borderRightWidth);
        const y = box.top + parseFloat(cs.borderTopWidth), endY = box.bottom - parseFloat(cs.borderBottomWidth);
        if (xClips && (left < x - 1 || right > endX + 1) || yClips && top !== null && bottom !== null && (top < y - 1 || bottom > endY + 1))
          failures.push(`${text[offset]} ink clipped by ${clip.id || clip.className}: ink[${left.toFixed(1)},${right.toFixed(1)};${top?.toFixed(1)},${bottom?.toFixed(1)}] clip[${x.toFixed(1)},${endX.toFixed(1)};${y.toFixed(1)},${endY.toFixed(1)}]`);
      }
    }
  }
  return failures;
};

for (const [surface, width, fontSize, family] of [
  ['page', 1160, 16, 'system-ui'], ['page', 320, 16, 'system-ui'], ['page', 320, 32, 'system-ui'], ['page', 430, 24, 'Arial, sans-serif'],
  ['status', 320, 32, 'system-ui'], ['status', 430, 24, 'system-ui'], ['compact', 320, 32, 'system-ui'], ['compact', 430, 24, 'Arial, sans-serif'],
] as const) {
  test(`${surface} numeric glyph ink is complete at ${width}px/${fontSize}px with ${family}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.goto(`/v2?surface=${surface === 'status' ? 'status' : 'page'}&state=decode&chat=local`);
    if (surface === 'status') await page.locator('iframe').evaluate((element, width) => { element.style.width = `${width}px`; }, width);
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('#rate')).toHaveText('26.4');
    if (surface === 'compact') {
      await frame.locator('#monitor-menu > summary').click(); await frame.locator('#compact').click();
      await expect(frame.locator('#compact-glance .ws')).toBeVisible();
    }
    const readout = frame.locator(surface === 'compact' ? '#compact-glance #rate' : '#rate');
    await frame.locator('html').evaluate((element, options) => {
      element.style.fontSize = `${options.fontSize}px`; element.style.setProperty('--oc-font', options.family);
    }, { fontSize, family });
    for (const [value, display] of [[25.6, '25.6'], [888.8, '889'], [88888, '88,888'], [99999.9, '100K']] as const) {
      await page.evaluate(value => {
        const w = window as any, runtime = w.ScopeStates.mockBody('decode', { now: Date.now() }).runtime;
        runtime.request.decodeTps = value; w.setPreviewPatch({ runtime });
      }, value);
      if (surface !== 'status') { await frame.locator('#monitor-menu > summary').click(); await frame.locator('#refresh').click(); }
      await expect(readout).toHaveText(display);
      await readout.scrollIntoViewIfNeeded();
      const renderedFont = await readout.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
      if (fontSize > 16) {
        await frame.locator('html').evaluate(element => { element.style.fontSize = '16px'; });
        const ordinaryFont = await readout.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
        await frame.locator('html').evaluate((element, size) => { element.style.fontSize = `${size}px`; }, fontSize);
        expect(renderedFont, `${display}: enlarged text must not shrink below its ordinary-size rendering`).toBeGreaterThanOrEqual(ordinaryFont);
      }
      // Restoring enlarged type can reset the bounded Session scroll position. Inspect its reachable full readout.
      await readout.scrollIntoViewIfNeeded();
      expect(await readout.evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        return new Set(Array.from(range.getClientRects(), rect => Math.round(rect.top))).size;
      }), `${display} must remain one readable numeric line`).toBe(1);
      expect(await readout.locator('.digit-cell').count(), 'static standard numerals must have no per-digit clip boxes').toBe(0);
      expect(await readout.evaluate(clippedInk), `${display} must render complete ink`).toEqual([]);
      expect(await frame.locator('#scope').evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${display} must fit without horizontal scrolling`).toBe(true);
    }
  });
}
