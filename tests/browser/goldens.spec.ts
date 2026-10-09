import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Frame, type Page } from '@playwright/test';

// 3.0 presentation goldens (legacy path tests/goldens/2.0): the current panel on the 2.0.4 fixture host, which answers
// /v2/snapshot from the approved G2 mock's v2 states (docs/design/2.0-mock-fixtures.json, panel/testing/mock-states.ts).
// Time is a paused fake clock advanced in 500 ms steps; after every step a postMessage barrier (panel → host → panel,
// FIFO) waits until each request the panel sent has been answered and handled. Text goldens run everywhere; pixel
// goldens are macOS-only (plan §8). Regenerate with GOLDENS_UPDATE=1 bun run test:goldens.
const EPOCH = Date.UTC(2026, 8, 29, 14, 5);
const STEP_MS = 500;
const STEPS = 16;
const PIXELS = process.platform === 'darwin';
const repo = (): string => join(test.info().project.testDir, '..', '..');
const release = (): string => (JSON.parse(readFileSync(join(repo(), 'package.json'), 'utf8')) as { version: string }).version;

type Theme = 'dark' | 'light';
type Variant = { width: number; theme: Theme; surface: 'panel' | 'page' | 'status'; extra?: string };
/** `server`: also the secondary diagnostics view. `shots`: the pixel goldens this case keeps (macOS). */
type Case = { name: string; state: string; server?: boolean; page?: boolean; light?: boolean; compact?: boolean; shots?: string[] };
const CASES: Case[] = [
  { name: 'decode', state: 'decode', server: true, page: true, light: true, compact: true, shots: ['live-320-dark', 'live-320-light', 'server-320-dark', 'live-1160-dark', 'compact-320-dark'] },
  { name: 'prefill', state: 'prefill', server: true, light: true, shots: ['live-320-dark', 'live-320-light'] },
  { name: 'idle', state: 'idle', server: true, shots: ['live-320-dark'] },
  { name: 'offline', state: 'offline', page: true, light: true, shots: ['live-320-dark', 'live-320-light', 'live-1160-dark'] },
  { name: 'pressure', state: 'pressure', page: true, compact: true, shots: ['live-320-dark', 'live-1160-dark', 'compact-320-dark'] },
  { name: 'pressure-critical', state: 'pressure-critical', light: true, shots: ['live-320-dark', 'live-320-light'] },
  { name: 'splash-decode', state: 'splash-decode', server: true, page: true, light: true, shots: ['live-320-dark', 'live-1160-dark'] },
  { name: 'splash-recovering', state: 'splash-recovering', server: true, shots: ['live-320-dark', 'server-320-dark'] },
  { name: 'runtime-changed', state: 'runtime-changed', shots: ['live-320-dark'] },
  { name: 'admin-unauthorized', state: 'admin-unauthorized', server: true, shots: ['live-320-dark'] },
  { name: 'llama', state: 'llama', server: true, shots: ['live-320-dark', 'server-320-dark'] },
  { name: 'llama-sleeping', state: 'llama-sleeping', server: true },
  { name: 'ollama', state: 'ollama', server: true, shots: ['server-320-dark'] },
  { name: 'bionic', state: 'bionic', server: true, light: true, shots: ['live-320-dark', 'server-320-dark', 'server-320-light'] },
  { name: 'detecting', state: 'detecting' },
  { name: 'thermal', state: 'thermal' },
  { name: 'needs-approval', state: 'needs-approval', page: true, shots: ['live-320-dark', 'live-1160-dark'] },
  { name: 'contract-mismatch', state: 'contract-mismatch', shots: ['live-320-dark'] },
];
/** The Work Status section at 280 px: every height it asks for. */
const STATUS: Array<{ name: string; query: string; theme?: Theme; shot?: boolean }> = [
  { name: 'status-tip', query: 'state=decode', shot: true },
  { name: 'status-decode', query: 'state=decode&pref=tip', shot: true },
  { name: 'status-decode-light', query: 'state=decode&pref=tip', theme: 'light', shot: true },
  { name: 'status-prefill', query: 'state=prefill&pref=tip' },
  { name: 'status-idle', query: 'state=idle&pref=tip' },
  { name: 'status-alert', query: 'state=pressure&pref=tip', shot: true },
  { name: 'status-offline', query: 'state=offline&pref=tip' },
  { name: 'status-splash-decode', query: 'state=splash-decode&pref=tip', shot: true },
  { name: 'status-splash-decode-light', query: 'state=splash-decode&pref=tip', theme: 'light', shot: true },
  { name: 'status-recovering', query: 'state=splash-recovering&pref=tip' },
  { name: 'status-approval', query: 'state=needs-approval&pref=tip' },
  { name: 'status-nonlocal', query: 'state=decode&pref=tip&chat=cloud', shot: true },
  { name: 'status-turnstats', query: 'state=bionic&pref=turn', shot: true },
  { name: 'status-turnstats-light', query: 'state=bionic&pref=turn', theme: 'light', shot: true },
];

// Runs in every frame before page scripts. The host answers each panel ping after handling everything the panel sent
// before it; the pong reports how many SDK messages the host had received by then. `pref` seeds pref.v2 (the first-run
// notice dismissed, so each glance case shows its own state).
const barrier = (pref: string | null): void => {
  const scope = window as unknown as Record<string, unknown>;
  if (window === window.top) {
    if (pref === 'tip') sessionStorage.setItem('pref.v2', JSON.stringify({ tipDismissed: true, noticeDismissed: true }));
    if (pref === 'turn') sessionStorage.setItem('pref.v2', JSON.stringify({ tipDismissed: true, noticeDismissed: true, statusExpanded: true }));
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

// Runs in the panel frame: `label {attributes}: text` for every visible element with an id, a data-key, a heading, a
// tab, a chip or a live/progress/img/note role, in DOM order. Containers list only their own text; live regions follow.
const dump = ([selector, release]: [string, string]): string => {
  const root = document.querySelector(selector)!;
  const keyed = (el: Element) => el.id !== '' || el.hasAttribute('data-key') || el.matches('h1,h2,h3,.chip,.val,[role=tab],[role=status],[role=alert],[role=note],[role=img],[aria-live],[role=progressbar]');
  const shown = (el: Element) => el.checkVisibility({ visibilityProperty: true });
  const clean = (text: string) => text.replaceAll(release, '<version>').split('\n').map(line => line.replace(/[ \t\r]+/g, ' ').trim()).filter(Boolean).join(' | ');
  const label = (el: Element) => el === root ? selector : el.id ? `#${el.id}` : el.hasAttribute('data-key') ? `[${el.getAttribute('data-key')}]`
    : `${el.localName}${el.classList.length ? `.${Array.from(el.classList).join('.')}` : ''}${el.hasAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}`;
  const own = (el: Element): string[] => Array.from(el.childNodes).flatMap(node => node.nodeType === Node.TEXT_NODE ? shown(el) ? [node.textContent ?? ''] : []
    : node instanceof Element && !keyed(node) ? own(node) : []);
  const attrs = (el: Element) => Array.from(el.attributes).map(a => a.name)
    .filter(name => name.startsWith('aria-') || name.startsWith('data-') && name !== 'data-key' || ['disabled', 'open', 'hidden', 'style', 'd'].includes(name)).sort()
    .map(name => `${name}=${JSON.stringify(el.getAttribute(name))}`);
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

  static async open(browser: Browser, baseURL: string, query: string, variant: Variant, pref: string | null = null): Promise<Harness> {
    const status = variant.surface === 'status';
    const context = await browser.newContext({ baseURL, viewport: { width: status ? 300 : variant.width, height: 900 }, deviceScaleFactor: 1,
      locale: 'en-US', timezoneId: 'UTC', colorScheme: variant.theme, reducedMotion: 'reduce' });
    await context.addInitScript(barrier, pref);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.clock.install({ time: EPOCH });
    await page.clock.pauseAt(EPOCH + 10_000);
    const params = [query, variant.theme === 'dark' ? '' : `theme=${variant.theme}`, variant.surface === 'panel' ? '' : `surface=${variant.surface}`].filter(Boolean).join('&');
    await page.goto(`/v2?${params}`);
    const panel = page.mainFrame().childFrames()[0]!;
    await until(() => panel.evaluate(() => document.querySelector<HTMLElement>('#scope')?.hidden === false && '__goldenPing' in window), 'the panel to mount');
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
  async text(label: string, selector = 'main.scope'): Promise<string> {
    await this.panel.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const { width, theme, surface } = this.variant;
    return `## ${label} · ${surface === 'status' ? 280 : width} ${theme} ${surface}\n${await this.panel.evaluate(dump, [selector, release()] as [string, string])}\n`;
  }
  async shot(name: string): Promise<void> {
    if (!PIXELS) return;
    const status = this.variant.surface === 'status', width = status ? 300 : this.variant.width;
    const height = await this.panel.evaluate(() => Math.ceil(document.querySelector('main.scope')!.getBoundingClientRect().bottom) + 16);
    await this.page.setViewportSize({ width, height: height + 24 });
    await expect.soft(this.panel.locator(status ? '#ws' : 'main.scope')).toHaveScreenshot(`${name}.png`,
      { mask: status ? [] : [this.panel.locator('#scope-version:visible')], maskColor: '#808080' });
    await this.page.setViewportSize({ width, height: 900 });
  }
  async close(): Promise<void> {
    expect(this.errors, 'page and console errors').toEqual([]);
    await this.page.context().close();
  }
}

test.describe.configure({ timeout: 180_000 });

for (const item of CASES) {
  test(`3.0 golden · ${item.name}`, async ({ browser, baseURL }) => {
    const shots = new Set(item.shots), query = `state=${item.state}`;
    const open = async (variant: Variant) => { const harness = await Harness.open(browser, baseURL!, query, variant); await harness.advance(STEPS); return harness; };
    const sections: string[] = [`# ${item.name} · /v2?${query}\n`];
    const main = await open({ width: 320, theme: 'dark', surface: 'panel' });
    sections.push(await main.text('live'));
    if (shots.has('live-320-dark')) await main.shot(`${item.name}-live-320-dark`);
    if (item.server) {
      await main.click('[data-action="open-server"]');
      sections.push(await main.text('server'));
      if (shots.has('server-320-dark')) await main.shot(`${item.name}-server-320-dark`);
    }
    await main.close();
    if (item.compact) {
      const compact = await open({ width: 320, theme: 'dark', surface: 'panel' });
      await compact.click('#monitor-menu > summary');
      await compact.click('#compact');
      sections.push(await compact.text('compact'));
      if (shots.has('compact-320-dark')) await compact.shot(`${item.name}-compact-320-dark`);
      await compact.close();
    }
    if (item.light) {
      const light = await open({ width: 320, theme: 'light', surface: 'panel' });
      sections.push(await light.text('live'));
      if (shots.has('live-320-light')) await light.shot(`${item.name}-live-320-light`);
      if (shots.has('server-320-light')) { await light.click('[data-action="open-server"]'); await light.shot(`${item.name}-server-320-light`); }
      await light.close();
    }
    if (item.page) {
      const page = await open({ width: 1160, theme: 'dark', surface: 'page' });
      sections.push(await page.text('live'));
      if (shots.has('live-1160-dark')) await page.shot(`${item.name}-live-1160-dark`);
      await page.close();
    }
    expect(sections.join('\n')).toMatchSnapshot(`${item.name}.txt`);
  });
}

test('3.0 golden · Work Status section at 280 px', async ({ browser, baseURL }) => {
  const sections: string[] = ['# Work Status section · 280 px\n'];
  for (const item of STATUS) {
    const pref = /pref=(tip|turn)/.exec(item.query)?.[1] ?? null;
    const harness = await Harness.open(browser, baseURL!, item.query.replace(/&?pref=(tip|turn)/, ''), { width: 280, theme: item.theme ?? 'dark', surface: 'status' }, pref);
    await harness.advance(STEPS);
    const heights = await harness.page.evaluate(() => (window as unknown as { previewHeights: number[] }).previewHeights);
    sections.push(`${await harness.text(item.name)}setHeight: ${heights.at(-1)}\n`);
    if (item.shot) await harness.shot(item.name);
    await harness.close();
  }
  expect(sections.join('\n')).toMatchSnapshot('status.txt');
});

test('cleanup golden · Live, History and Captures at 430 px', async ({ browser, baseURL }) => {
  const sections: string[] = ['# Two primary destinations · 430 px\n'];
  for (const theme of ['dark', 'light'] as const) {
    const harness = await Harness.open(browser, baseURL!, `demo=1&state=decode&chat=local&theme=${theme}`, { width: 430, theme, surface: 'panel' }, 'tip');
    await harness.advance(STEPS);
    sections.push(await harness.text('live'));
    await harness.shot(`cleanup-live-430-${theme}`);
    await harness.click('#tab-history');
    sections.push(await harness.text('history'));
    await harness.shot(`cleanup-history-430-${theme}`);
    await harness.click('[data-action="open-captures"]');
    sections.push(await harness.text('reply capture'));
    await harness.shot(`cleanup-captures-430-${theme}`);
    await harness.click('[data-action="capture-method"][data-arg="window"]');
    sections.push(await harness.text('timed capture'));
    await harness.shot(`cleanup-timed-430-${theme}`);
    await harness.close();
  }
  expect(sections.join('\n')).toMatchSnapshot('cleanup-navigation.txt');
});

test('pixel goldens stay within the repository budget', () => {
  const dir = join(repo(), 'tests', 'goldens', '2.0');
  const images = readdirSync(dir).filter(file => file.endsWith('.png'));
  expect(images.length).toBeLessThanOrEqual(60);
  expect(images.reduce((total, file) => total + statSync(join(dir, file)).size, 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
});
