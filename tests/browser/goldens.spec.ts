import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Frame, type Page } from '@playwright/test';

// Stage 1 goldens: the 1.6 panel on the synthetic host, frozen so Stage 2a can prove it renders identically.
// Time is a paused fake clock advanced in poll-aligned 500 ms steps; after every step a postMessage barrier
// (panel → host → panel, FIFO) waits until each request the panel sent has been answered and handled.
// Text goldens run everywhere; pixel goldens are macOS-only (§8). Regenerate with GOLDENS_UPDATE=1.
const EPOCH = Date.UTC(2026, 0, 15, 9, 30);
const STEP_MS = 500;
const STEPS = 16;
const PIXELS = process.platform === 'darwin';
const repo = (): string => join(test.info().project.testDir, '..', '..');
const release = (): string => (JSON.parse(readFileSync(join(repo(), 'package.json'), 'utf8')) as { version: string }).version;

type Theme = 'dark' | 'light';
type Case = { name: string; query: string; provider?: string; full?: boolean; shots?: string[]; act?: (h: Harness) => Promise<void> };
type Variant = { width: number; theme: Theme; surface: 'panel' | 'page' };

const CASES: Case[] = [
  { name: 'omlx-decode', query: 'state=decode', full: true, shots: ['server', 'compare', 'saved', 'compact'] },
  { name: 'omlx-prefill', query: 'state=prefill', full: true, shots: ['compact'] },
  { name: 'omlx-idle', query: 'state=idle' },
  { name: 'omlx-offline', query: 'state=offline', full: true },
  { name: 'omlx-auth', query: 'state=auth' },
  { name: 'omlx-stalled', query: 'state=stalled' },
  { name: 'omlx-multi', query: 'multi=1' },
  { name: 'omlx-not-loaded', query: 'state=notLoaded' },
  { name: 'dflash-preparing', query: 'state=dflash-preparing' },
  { name: 'splash-ready', query: 'connections=1', provider: 'splash', full: true, shots: ['server'] },
  { name: 'splash-loading', query: 'connections=1&splashReady=0', provider: 'splash' },
  { name: 'bionic-decode', query: 'connections=1&bionic=decode', provider: 'bionic', full: true, shots: ['server'] },
  { name: 'bionic-prefill', query: 'connections=1&bionic=prefill', provider: 'bionic' },
  { name: 'bionic-idle', query: 'connections=1&bionic=idle', provider: 'bionic' },
  { name: 'lmstudio-inventory', query: 'connections=1', provider: 'studio', full: true, shots: ['server'] },
  { name: 'vllm-mlx-live', query: 'connections=1&vllm=live&state=decode', provider: 'vllm' },
  { name: 'mlx-lm-inventory', query: 'connections=1', provider: 'mlx' },
  { name: 'setup-missing', query: 'connections=1&setup=missing' },
  { name: 'custom-needs-runtime', query: 'connections=1', provider: 'custom' },
  { name: 'service-denied', query: 'state=offline&denied=1', act: async h => {
    await h.click('#connection-help > summary'); await h.click('#check-connection');
  } },
];

// Runs in every frame before page scripts. The host answers each panel ping after handling everything the
// panel sent before it; the pong reports how many SDK messages the host had received by then.
const barrier = (provider: string | null): void => {
  const scope = window as unknown as Record<string, unknown>;
  if (window === window.top) {
    if (provider) scope.previewAutoProvider = provider;
    let received = 0;
    addEventListener('message', event => {
      const frame = document.querySelector('iframe');
      if (!frame || event.source !== frame.contentWindow) return;
      if (event.data?.channel === 'openchamber.sdk') received += 1;
      else if (event.data?.golden === 'ping') frame.contentWindow!.postMessage({ golden: 'pong', seq: event.data.seq, received }, '*');
    });
  } else {
    scope.__goldenPong = { seq: 0, received: 0 };
    addEventListener('message', event => { if (event.source === parent && event.data?.golden === 'pong') scope.__goldenPong = event.data; });
    scope.__goldenPing = (seq: number) => parent.postMessage({ golden: 'ping', seq }, '*');
  }
};

// Runs in the panel frame: `label {attributes}: text` for every visible element with an id, heading, tab or
// live/progress/slider role, in DOM order. Containers list only their own text; live regions follow, hidden or not.
const dump = ([selector, release]: [string, string]): string => {
  const root = document.querySelector(selector)!;
  const keyed = (el: Element) => el.id !== '' || el.matches('h1,h2,h3,h4,[role=tab],[role=status],[role=alert],[aria-live],[role=progressbar],[role=slider]');
  const shown = (el: Element) => el.checkVisibility({ visibilityProperty: true });
  const clean = (text: string) => text.replaceAll(release, '<version>').split('\n').map(line => line.replace(/[ \t\r]+/g, ' ').trim()).filter(Boolean).join(' | ');
  const label = (el: Element) => el === root ? selector : el.id ? `#${el.id}` : `${el.localName}${el.hasAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}`;
  const own = (el: Element): string[] => Array.from(el.childNodes).flatMap(node => node.nodeType === Node.TEXT_NODE ? shown(el) ? [node.textContent ?? ''] : []
    : node instanceof Element && !keyed(node) ? own(node) : []);
  const attrs = (el: Element) => [...Array.from(el.attributes).map(a => a.name).filter(name => name.startsWith('aria-') || ['title', 'disabled', 'open', 'hidden', 'style', 'd', 'cx', 'cy'].includes(name)).sort()
    .map(name => `${name}=${JSON.stringify(el.getAttribute(name))}`),
  ...(el instanceof SVGElement ? Array.from(el.children).filter(child => child.hasAttribute('d')).map((child, index) => `d${index}=${JSON.stringify(child.getAttribute('d'))}`) : [])];
  const lines = [root, ...Array.from(root.querySelectorAll('*'))].filter(el => (el === root || keyed(el)) && shown(el)).map(el => {
    const text = el instanceof SVGElement ? '' : Array.from(el.querySelectorAll('*')).some(keyed) ? clean(own(el).join(' ')) : clean((el as HTMLElement).innerText);
    const list = attrs(el);
    return `${label(el)}${list.length ? ` {${list.join(' ')}}` : ''}${text ? `: ${text}` : ''}`;
  });
  const live = Array.from(root.querySelectorAll('[role=status],[role=alert],[aria-live]')).map(el => `live ${label(el)}${shown(el) ? '' : ' (hidden)'}: ${clean(el.textContent ?? '')}`);
  return [...lines, ...live].join('\n');
};

const until = async (check: () => Promise<boolean>, what: string): Promise<void> => {
  for (const started = Date.now(); !(await check()); await new Promise(resolve => setTimeout(resolve, 5))) {
    if (Date.now() - started > 10_000) throw new Error(`Timed out waiting for ${what}`);
  }
};

class Harness {
  private seq = 0;
  private constructor(readonly page: Page, readonly panel: Frame, readonly variant: Variant, private readonly errors: string[]) {}

  static async open(browser: Browser, baseURL: string, item: Case, variant: Variant): Promise<Harness> {
    const context = await browser.newContext({ baseURL, viewport: { width: variant.width, height: 900 }, deviceScaleFactor: 1,
      locale: 'en-US', timezoneId: 'UTC', colorScheme: variant.theme, reducedMotion: 'reduce' });
    await context.addInitScript(barrier, item.provider ?? null);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.clock.install({ time: EPOCH });
    await page.clock.pauseAt(EPOCH + 10_000);
    const query = [item.query, variant.theme === 'dark' ? '' : `theme=${variant.theme}`, variant.surface === 'page' ? 'surface=page' : ''].filter(Boolean).join('&');
    await page.goto(`/?${query}`);
    const panel = page.mainFrame().childFrames()[0]!;
    await until(() => panel.evaluate(() => document.querySelector<HTMLElement>('.scope')?.hidden === false && '__goldenPing' in window), 'the panel to mount');
    const harness = new Harness(page, panel, variant, errors);
    await harness.sync();
    return harness;
  }

  /** Repeat the barrier until a full round trip carries no new panel traffic. */
  async sync(): Promise<void> {
    let previous = -1;
    for (let rounds = 0; rounds < 50; rounds += 1) {
      const seq = ++this.seq;
      await this.panel.evaluate(value => (window as unknown as { __goldenPing: (seq: number) => void }).__goldenPing(value), seq);
      let received = -1;
      await until(async () => {
        const pong = await this.panel.evaluate(() => (window as unknown as { __goldenPong: { seq: number; received: number } }).__goldenPong);
        received = pong.received;
        return pong.seq === seq;
      }, 'the host barrier');
      if (received === previous) return;
      previous = received;
    }
    throw new Error('The panel never settled');
  }

  async advance(steps: number): Promise<void> {
    for (let step = 0; step < steps; step += 1) { await this.page.clock.runFor(STEP_MS); await this.sync(); }
  }

  async click(selector: string): Promise<void> {
    await this.panel.locator(selector).click();
    await this.page.mouse.move(0, 0);
    await this.sync();
  }

  async menu(selector: string): Promise<void> {
    if (!(await this.panel.locator('#monitor-menu').evaluate(element => (element as HTMLDetailsElement).open))) await this.click('#monitor-menu > summary');
    await this.click(selector);
  }

  async text(label: string, selector = 'main.scope'): Promise<string> {
    await this.panel.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    return `## ${label} · ${this.variant.width} ${this.variant.theme} ${this.variant.surface}\n${await this.panel.evaluate(dump, [selector, release()] as [string, string])}\n`;
  }

  async shot(name: string): Promise<void> {
    if (!PIXELS) return;
    const { width } = this.variant;
    const height = await this.panel.evaluate(() => Math.ceil(document.querySelector('main.scope')!.getBoundingClientRect().bottom) + 16);
    await this.page.setViewportSize({ width, height: height + 24 });
    await expect.soft(this.panel.locator('main.scope')).toHaveScreenshot(`${name}.png`, { mask: [this.panel.locator('#scope-version')], maskColor: '#808080' });
    await this.page.setViewportSize({ width, height: 900 });
  }

  async close(): Promise<void> {
    expect(this.errors, 'page and console errors').toEqual([]);
    await this.page.context().close();
  }
}

test.describe.configure({ timeout: 180_000 });

for (const item of CASES) {
  test(`1.6 golden · ${item.name}`, async ({ browser, baseURL }) => {
    const shots = new Set(item.shots);
    const open = async (variant: Variant) => {
      const harness = await Harness.open(browser, baseURL!, item, variant);
      await harness.advance(STEPS);
      if (item.act) await item.act(harness);
      return harness;
    };
    const sections: string[] = [`# ${item.name} · ?${item.query}${item.provider ? ` · automatic connection: ${item.provider}` : ''}\n`];

    const main = await open({ width: 320, theme: 'dark', surface: 'panel' });
    sections.push(await main.text('live'));
    await main.shot(`${item.name}-live-320-dark`);
    if (item.full) {
      await main.click('#monitor-menu > summary');
      sections.push(await main.text('menu', '#monitor-menu'));
      await main.panel.locator('#monitor-menu > summary').press('Escape');
      for (const view of ['server', 'compare', 'saved'] as const) {
        await main.click(`#tab-${view}`);
        sections.push(await main.text(view));
        if (shots.has(view)) await main.shot(`${item.name}-${view}-320-dark`);
      }
    }
    await main.close();
    if (!item.full) { expect(sections.join('\n')).toMatchSnapshot(`${item.name}.txt`); return; }

    const compact = await open({ width: 320, theme: 'dark', surface: 'panel' });
    await compact.menu('#compact');
    sections.push(await compact.text('compact'));
    if (shots.has('compact')) await compact.shot(`${item.name}-compact-320-dark`);
    await compact.close();
    for (const variant of [{ width: 320, theme: 'light', surface: 'panel' }, { width: 1160, theme: 'dark', surface: 'page' }] as const) {
      const harness = await open(variant);
      sections.push(await harness.text('live'));
      await harness.shot(`${item.name}-live-${variant.width}-${variant.theme}`);
      await harness.close();
    }
    expect(sections.join('\n')).toMatchSnapshot(`${item.name}.txt`);
  });
}

test('pixel goldens stay within the repository budget', () => {
  const dir = join(repo(), 'tests', 'goldens', '1.6');
  const images = readdirSync(dir).filter(file => file.endsWith('.png'));
  expect(images.length).toBeLessThanOrEqual(60);
  expect(images.reduce((total, file) => total + statSync(join(dir, file)).size, 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
});
