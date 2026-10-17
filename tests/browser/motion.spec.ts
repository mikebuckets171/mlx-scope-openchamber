import { expect, test, type FrameLocator, type Page } from '@playwright/test';

// The 3.2 motion system: every animation is caused by a truthful change arriving, runs once, and nothing loops.
// Hidden or paused frames animate nothing; Reduce Motion makes every change instant.
type Running = { name: string; duration: number; iterations: number };
const running = (frame: FrameLocator, selector: string): Promise<Running[]> => frame.locator('html').evaluate((root, selector) =>
  root.ownerDocument.getAnimations().filter(animation => {
    const target = (animation.effect as KeyframeEffect | null)?.target as Element | null;
    return !!target && target.matches(selector) && animation.playState !== 'finished';
  }).map(animation => {
    const timing = animation.effect!.getComputedTiming();
    return { name: (animation.effect as KeyframeEffect).target!.className.toString(), duration: Number(timing.duration), iterations: Number(timing.iterations) };
  }), selector);
// Cloud delivery is an estimate: it reads "≈ 17.8" and is labelled This chat.
const generating = (page: Page, rate: number, elapsed = 3_000) => page.evaluate(({ rate, elapsed }) => {
  const now = Date.now();
  (window as any).setPreviewPatch({ chat: { scope: 'chat', basis: 'estimated-characters', timingBasis: 'delivery-window', phase: 'generating',
    tokensPerSecond: rate, observedAtMs: now, expiresAtMs: now + 5_000, observation: { startedAtMs: now - elapsed, endedAtMs: now }, freshness: 'live' } });
}, { rate, elapsed });

test('a new activity beats the mark once; newer readings in the same activity stay still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/v2?surface=page&state=decode&chat=cloud&poll=500');
  const frame = page.frameLocator('iframe');
  // Record every motion the mark starts, rather than racing a 260 ms animation.
  await frame.locator('html').evaluate(root => {
    const w = root.ownerDocument.defaultView as any, original = w.Element.prototype.animate; w.beats = [];
    w.Element.prototype.animate = function (this: Element, ...args: any[]) {
      if (this.hasAttribute('data-heartbeat')) w.beats.push({ duration: args[1]?.duration, iterations: args[1]?.iterations ?? 1 });
      return original.apply(this, args);
    };
  });
  const beats = () => frame.locator('html').evaluate(root => (root.ownerDocument.defaultView as any).beats.length as number);
  await generating(page, 17.8);
  await expect(frame.locator('#rate')).toHaveText('≈ 17.8');
  await expect.poll(beats).toBe(1);
  await generating(page, 18.4);
  await expect(frame.locator('#rate')).toHaveText('≈ 18.4');
  await page.waitForTimeout(600);
  expect(await beats()).toBe(1);
  expect(await frame.locator('html').evaluate(root => (root.ownerDocument.defaultView as any).beats)).toEqual([{ duration: 260, iterations: 1 }]);
  // Nothing anywhere in the frame is infinite.
  expect(await frame.locator('html').evaluate(root => root.ownerDocument.getAnimations()
    .filter(animation => animation.effect?.getComputedTiming().iterations === Infinity).length)).toBe(0);
  // Polls that bring no newer observation are still: the beat is keyed to the reading, not to the poll.
  await page.waitForTimeout(1_300);
  expect(await beats()).toBe(1);
});

test('an arriving block fades in once and settles; later polls never re-animate it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/v2?surface=page&state=decode&chat=cloud&poll=500');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.instrument-phase')).toHaveText('Ready');
  await generating(page, 17.8);
  await expect(frame.locator('.instrument-primary')).toBeVisible();
  await frame.locator('.instrument-primary').evaluate(node => { (window as any).arrived = node; });
  await generating(page, 18.4);
  await expect(frame.locator('#rate')).toHaveText('≈ 18.4');
  expect(await frame.locator('.instrument-primary').evaluate(node => node === (window as any).arrived)).toBe(true);
  await page.waitForTimeout(400);
  expect(await running(frame, '.instrument-primary')).toEqual([]);
});

test('a changed phase crossfades; Reduce Motion makes every change instant', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/v2?surface=status&state=decode&chat=cloud&poll=500');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.ws-phase')).toHaveText('Ready');
  await frame.locator('html').evaluate(root => {
    const w = root.ownerDocument.defaultView as any; w.crossfades = [];
    new w.MutationObserver(() => { for (const animation of root.ownerDocument.getAnimations()) {
      const target = (animation.effect as KeyframeEffect | null)?.target as Element | null;
      if (target?.matches('.ws-phase')) w.crossfades.push(Number(animation.effect!.getComputedTiming().duration));
    } }).observe(root, { subtree: true, characterData: true, childList: true, attributes: true });
  });
  await generating(page, 17.8);
  await expect(frame.locator('.ws-phase')).toHaveText('Generating');
  await expect.poll(() => frame.locator('html').evaluate(root => (root.ownerDocument.defaultView as any).crossfades.includes(120))).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await generating(page, 19.1);
  await expect(frame.locator('#rate')).toHaveText('≈ 19.1');
  await page.evaluate(() => { const now = Date.now(); (window as any).setPreviewPatch({ chat: { scope: 'chat', basis: 'estimated-characters',
    timingBasis: 'delivery-window', phase: 'tool', observedAtMs: now, expiresAtMs: now + 5_000, observation: { startedAtMs: now, endedAtMs: now }, freshness: 'live' } }); });
  await expect(frame.locator('.ws-phase')).toHaveText('Using tools');
  expect(await frame.locator('html').evaluate(root => root.ownerDocument.getAnimations().length)).toBe(0);
});

test('an unchanged visible source label stays still when its hidden measurement basis changes', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/v2?surface=page&state=decode&chat=cloud&poll=500');
  const frame = page.frameLocator('iframe');
  await generating(page, 17.8);
  await expect(frame.locator('#rate')).toHaveText('≈ 17.8');
  const source = frame.locator('.instrument-source'), basis = source.locator('.basis');
  const before = await basis.textContent();
  await expect(source).toHaveAttribute('data-crossfade', 'This chat');
  await source.evaluate(node => {
    const w = node.ownerDocument.defaultView as any, original = w.Element.prototype.animate; w.sourceFades = 0;
    w.Element.prototype.animate = function (this: Element, ...args: any[]) {
      if (this.classList.contains('instrument-source')) w.sourceFades++;
      return original.apply(this, args);
    };
  });
  await generating(page, 18.4, 4_500);
  await expect(frame.locator('#rate')).toHaveText('≈ 18.4');
  await expect(basis).not.toHaveText(before!);
  await expect(source).toHaveAttribute('data-crossfade', 'This chat');
  expect(await source.evaluate(node => (node.ownerDocument.defaultView as any).sourceFades)).toBe(0);
});

test('a paused frame animates nothing when readings change', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/v2?surface=page&state=decode&chat=cloud&poll=500');
  const frame = page.frameLocator('iframe');
  await generating(page, 17.8);
  await expect(frame.locator('#rate')).toHaveText('≈ 17.8');
  await frame.locator('#pause').click();
  await generating(page, 21.0);
  await page.waitForTimeout(1_200);
  expect(await running(frame, '[data-heartbeat], [data-arrive], [data-crossfade]')).toEqual([]);
});

test('the standard instrument keeps values live with activity beats and honors reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/v2?surface=page&sdk=next&design=next&state=decode&chat=cloud&poll=500');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('html')).toHaveAttribute('data-design-mode', 'next');
  await expect(frame.locator('.instrument-phase')).toHaveText('Ready');
  await frame.locator('html').evaluate(root => {
    const w = root.ownerDocument.defaultView as any, original = w.Element.prototype.animate;
    w.nextMotion = { beats: 0, fades: 0 };
    w.Element.prototype.animate = function (this: Element, ...args: any[]) {
      if (this.hasAttribute('data-heartbeat')) w.nextMotion.beats++;
      if (this.hasAttribute('data-crossfade')) w.nextMotion.fades++;
      return original.apply(this, args);
    };
  });
  const counts = () => frame.locator('html').evaluate(root => ({ ...(root.ownerDocument.defaultView as any).nextMotion } as { beats: number; fades: number }));
  await generating(page, 17.8);
  await expect(frame.locator('#rate')).toHaveText('≈ 17.8');
  await expect.poll(async () => (await counts()).beats).toBe(1);
  expect((await counts()).fades).toBeGreaterThan(0);
  await generating(page, 18.4);
  await expect(frame.locator('#rate')).toHaveText('≈ 18.4');
  await page.waitForTimeout(600);
  expect((await counts()).beats).toBe(1);
  await expect(frame.locator('#design-mode,[data-design-choice]')).toHaveCount(0);
  await generating(page, 19.8);
  await expect(frame.locator('#rate')).toHaveText('≈ 19.8');
  await page.waitForTimeout(600);
  expect((await counts()).beats).toBe(1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await generating(page, 20.5);
  await expect(frame.locator('#rate')).toHaveText('≈ 20.5');
  expect(await frame.locator('html').evaluate(root => root.ownerDocument.getAnimations().length)).toBe(0);
});
