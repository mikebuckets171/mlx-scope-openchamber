import type { HostTheme, HostThemeTokens } from '@openchamber/sdk';
import { expect, test, type Frame, type Page } from '@playwright/test';
import { inspect } from './ui-checks.ts';

// Synthetic palettes exercise OpenChamber's live ready messages, without changing a user's host settings.
// Base fills deliberately differ from their readable text colors: a chart must use primaryText, not primary.
const VIOLET: HostTheme = { mode: 'dark', tokens: {
  background: '#14111c', elevated: '#211b2b', foreground: '#f2edf8', elevatedForeground: '#f2edf8',
  muted: '#b6acc5', subtle: '#a99cbb', border: '#564763', hover: '#332a42', active: '#403451',
  selection: '#4d3967', selectionForeground: '#f2edf8', focus: '#dcc0ff', mutedSurface: '#211b2b',
  primary: '#7651ac', primaryText: '#d2adff', primaryForeground: '#ffffff',
  success: '#228b62', successText: '#92ddaf', warning: '#bd7c23', warningText: '#f3cd83',
  error: '#c45167', errorText: '#ffadbb', info: '#4585ac', infoText: '#9bd2f4',
  font: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace', radius: '10px',
} };
const COPPER: HostTheme = { mode: 'dark', tokens: {
  ...VIOLET.tokens, background: '#1c1410', elevated: '#2e221b', mutedSurface: '#2a1f19',
  foreground: '#fbf0e7', elevatedForeground: '#fbf0e7', muted: '#ccb7a8', subtle: '#bca797',
  border: '#634b3b', hover: '#3b2b21', active: '#4d3528', selection: '#573c2b', selectionForeground: '#fbf0e7',
  primary: '#a15b34', primaryText: '#f4b484', focus: '#ffd5b8',
  success: '#3d8266', successText: '#a6d9b7', warning: '#b88032', warningText: '#f2cd87',
  error: '#bd5353', errorText: '#ffa6a0', info: '#458291', infoText: '#9cd6e0',
} };
const PAPER: HostTheme = { mode: 'light', tokens: {
  ...VIOLET.tokens, background: '#faf7f0', elevated: '#fffdf8', mutedSurface: '#eee9df',
  foreground: '#302c25', elevatedForeground: '#302c25', muted: '#645c50', subtle: '#706655',
  border: '#c2b7a5', hover: '#ece5d8', active: '#e3d6c4', selection: '#e1d0b8', selectionForeground: '#302c25',
  primary: '#94642e', primaryText: '#764812', focus: '#8d4c13',
  success: '#3f7857', successText: '#286341', warning: '#ad7731', warningText: '#775012',
  error: '#bf4f4e', errorText: '#9c303b', info: '#477599', infoText: '#315f83',
} };

type ThemeInput = { mode: HostTheme['mode']; tokens: Partial<HostThemeTokens> };
type Preview = Window & { setPreviewTheme: (value: string | ThemeInput) => void };
const rgb = (hex: string): string => `rgb(${[1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
const setTheme = (page: Page, value: string | ThemeInput) =>
  page.evaluate(next => (window as unknown as Preview).setPreviewTheme(next), value);
const load = async (page: Page, query = 'state=decode', width = 430): Promise<Frame> => {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`/v2?${query}`);
  const frame = page.frames().find(candidate => candidate !== page.mainFrame())!;
  await expect(frame.locator('#scope')).toBeVisible();
  if (!query.includes('surface=status')) await expect(frame.locator('#phase')).not.toHaveText('Connecting');
  return frame;
};
const expectPalette = async (frame: Frame, palette: HostTheme, transparent = false) => {
  await expect(frame.locator('html')).toHaveAttribute('data-oc-theme', palette.mode);
  await expect(frame.locator('html')).toHaveCSS('color-scheme', palette.mode);
  await expect(frame.locator('body')).toHaveCSS('background-color', transparent ? 'rgba(0, 0, 0, 0)' : rgb(palette.tokens.background));
  await expect(frame.locator('#scope')).toHaveCSS('color', rgb(palette.tokens.foreground));
};

test('a mounted panel repaints for same-mode custom themes and light/dark changes without losing its controls', async ({ page }) => {
  const frame = await load(page);
  // A constant fixture rate draws a horizontal SVG path with a zero-height bounding box.
  await expect(frame.locator('#signal')).toBeVisible({ timeout: 12_000 });
  await expect(frame.locator('#signal .trace')).toBeAttached();
  const mounted = await frame.locator('#scope').elementHandle();
  await frame.locator('#request-details > summary').click();
  await frame.locator('#request-details > summary').focus();

  for (const palette of [VIOLET, COPPER, PAPER, VIOLET]) {
    await setTheme(page, palette);
    await expectPalette(frame, palette);
    await expect(frame.locator('#signal .trace')).toHaveCSS('stroke', rgb(palette.tokens.primaryText));
    await expect(frame.locator('.scope-mark')).toHaveCSS('stroke', rgb(palette.tokens.primaryText));
    const menuSurface = await frame.locator('.monitor-menu-content').evaluate(el => {
      const style = getComputedStyle(el);
      return [style.backgroundColor, style.backgroundImage];
    });
    expect(menuSurface.some(value => value.includes(rgb(palette.tokens.elevated)))).toBe(true);
    await expect(frame.locator('#request-details')).toHaveJSProperty('open', true);
    await expect(frame.locator('#request-details > summary')).toBeFocused();
    expect(await mounted!.evaluate(el => el === document.querySelector('#scope'))).toBe(true);
  }

  // Selection belongs to the mounted view, not to its palette.
  await frame.getByRole('button', { name: 'Server & Mac details', exact: true }).click();
  await setTheme(page, PAPER);
  await expect(frame.getByRole('tab', { name: 'Live', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(frame.locator('#panel-server')).toBeVisible();
});

test('legacy palette updates clear old text tokens and use the current host primary fallback', async ({ page }) => {
  const frame = await load(page);
  await expect(frame.locator('#signal')).toBeVisible({ timeout: 12_000 });
  await expect(frame.locator('#signal .trace')).toBeAttached();
  await setTheme(page, VIOLET);
  await expect(frame.locator('#signal .trace')).toHaveCSS('stroke', rgb(VIOLET.tokens.primaryText));
  const tokens: Partial<HostThemeTokens> = { ...PAPER.tokens, primary: '#704720' };
  for (const key of ['primaryText', 'successText', 'warningText', 'errorText', 'infoText'] as const) delete tokens[key];
  await setTheme(page, { mode: 'light', tokens });
  await expect(frame.locator('body')).toHaveCSS('background-color', rgb(PAPER.tokens.background));
  await expect(frame.locator('#signal .trace')).toHaveCSS('stroke', rgb(tokens.primary!));
  expect(await frame.locator('html').evaluate(el => el.style.getPropertyValue('--oc-primary-text'))).toBe('');
  expect(await frame.locator('html').evaluate(el => el.style.getPropertyValue('--primary-text'))).toBe('');
});

test('the host primary remains the identity color during prefill while warnings and critical alerts keep their semantic tones', async ({ page }) => {
  let frame = await load(page, 'state=prefill');
  await setTheme(page, VIOLET);
  await expect(frame.locator('.progress-track > span')).toHaveCSS('background-color', rgb(VIOLET.tokens.primaryText));
  await expect(frame.locator('.scope-mark')).toHaveCSS('stroke', rgb(VIOLET.tokens.primaryText));

  for (const [state, severity, key] of [['pressure', 'warning', 'warningText'], ['pressure-critical', 'critical', 'errorText']] as const) {
    frame = await load(page, `state=${state}`);
    const alert = frame.locator('#view-live > .connection-diagnosis');
    await expect(alert).toHaveAttribute('data-severity', severity);
    for (const palette of [VIOLET, PAPER]) {
      await setTheme(page, palette);
      await expect(alert).toHaveCSS('--tone', palette.tokens[key]);
      await expect(frame.locator(`.machine-summary .level[data-level="${severity}"]`)).toHaveCSS('color', rgb(palette.tokens[key]));
      await expect(frame.locator('.scope-mark')).toHaveCSS('stroke', rgb(palette.tokens.primaryText));
    }
  }
});

test('the mounted Work Status indicator and alert follow custom host themes', async ({ page }) => {
  const frame = await load(page, 'surface=status&state=pressure-critical', 320);
  await expect(frame.locator('.ws-alert')).toBeVisible();
  const mounted = await frame.locator('#scope').elementHandle();
  for (const palette of [VIOLET, COPPER, PAPER]) {
    await setTheme(page, palette);
    await expectPalette(frame, palette, true);
    await expect(frame.locator('.ws-dot')).toHaveCSS('background-color', rgb(palette.tokens.primaryText));
    await expect(frame.locator('.ws-alert')).toHaveCSS('color', rgb(palette.tokens.errorText));
    expect(await mounted!.evaluate(el => el === document.querySelector('#scope'))).toBe(true);
    const backdrop = await page.locator('iframe').evaluate(el => {
      const colors: string[] = [];
      for (let node: Element | null = el; node; node = node.parentElement) colors.unshift(getComputedStyle(node).backgroundColor);
      return colors;
    });
    expect(await frame.evaluate(inspect, { openAll: false, backdrop })).toEqual([]);
  }
});

for (const [name, palette] of [['violet', VIOLET], ['paper', PAPER]] as const) {
  test(`custom ${name} theme keeps all views readable and inside the 320, 430 and 1160 px surfaces`, async ({ page }) => {
    for (const width of [320, 430, 1160]) {
      const frame = await load(page, `state=decode${width >= 900 ? '&surface=page' : ''}`, width);
      await setTheme(page, palette);
      await expectPalette(frame, palette);
      expect(await frame.evaluate(inspect, false), `${name} Live @ ${width}`).toEqual([]);
      await frame.getByRole('button', { name: 'Server & Mac details', exact: true }).click();
      expect(await frame.evaluate(inspect, false), `${name} Server @ ${width}`).toEqual([]);
      await frame.getByRole('tab', { name: 'History', exact: true }).click();
      expect(await frame.evaluate(inspect, false), `${name} History @ ${width}`).toEqual([]);
      await frame.getByRole('button', { name: 'Captures', exact: true }).click();
      expect(await frame.evaluate(inspect, false), `${name} Captures @ ${width}`).toEqual([]);
    }
  });
}
