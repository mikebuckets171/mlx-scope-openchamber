import { expect, test } from 'bun:test';
import { connectHost, OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL, type HostFrame,
  type HostReadyContext, type HostTheme, type HostThemeTokens } from '@openchamber/sdk';
import { applyHostReady } from './sdk-theme.ts';

const palette = (offset: number, mode: HostTheme['mode'] = 'dark'): HostTheme => {
  const color = (value: number): string => `#${(offset + value).toString(16).padStart(6, '0')}`;
  return { mode, tokens: {
    background: color(1), elevated: color(2), foreground: color(3), muted: color(4), subtle: color(5),
    border: color(6), hover: color(7), selection: color(8), focus: color(9), primary: color(10),
    mutedSurface: color(11), elevatedForeground: color(12), active: color(13), selectionForeground: color(14),
    primaryForeground: color(15), primaryText: color(16), successText: color(17), warningText: color(18),
    errorText: color(19), infoText: color(20), success: color(21), warning: color(22), error: color(23), info: color(24),
    font: `"Theme Sans ${offset}", sans-serif`, mono: `"Theme Mono ${offset}", monospace`, radius: `${offset / 100_000}px`,
  } };
};

const harness = () => {
  const values = new Map<string, string>();
  const root = { style: { colorScheme: '', setProperty: (name: string, value: string) => {
    // CSSStyleDeclaration.setProperty(name, '') removes the declaration.
    if (value === '') values.delete(name); else values.set(name, String(value));
  } },
    dataset: { ocSurface: '', ocTheme: '' } };
  const events = new EventTarget();
  const target = Object.assign(events, { parent: { postMessage: () => {} } }) as unknown as HostFrame;
  const host = connectHost({ target, acceptSource: () => true });
  let updates = 0;
  host.onReady(ready => { applyHostReady(ready, root); updates += 1; });
  const ready = (theme: HostTheme, surface: HostReadyContext['surface'] = 'panel'): void => {
    events.dispatchEvent(new MessageEvent('message', { data: {
      channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'ready',
      payload: { theme, surface, locale: 'en-US', directory: null, session: null,
        connection: { connected: true, account: '' }, settings: {}, item: null },
    } }));
  };
  return { values, root, ready, host, updates: () => updates };
};

test('successive host-ready palettes replace every color and typography token, including within the same mode', () => {
  const h = harness();
  try {
    const first = palette(100_000);
    h.ready(first);
    const written = new Map(h.values);
    for (const theme of [palette(200_000), palette(300_000, 'light')]) {
      h.ready(theme);
      expect(h.root.style.colorScheme).toBe(theme.mode);
      expect(h.root.dataset.ocTheme).toBe(theme.mode);
      expect(h.values.size).toBe(written.size);
      for (const [key, value] of Object.entries(first.tokens)) {
        const aliases = [...written].filter(([, original]) => original === value).map(([name]) => name);
        expect(aliases.length, key).toBeGreaterThanOrEqual(2);
        for (const name of aliases) expect(h.values.get(name), name).toBe(theme.tokens[key as keyof HostThemeTokens]);
        expect([...h.values.values()], key).not.toContain(value);
      }
    }
    expect(h.updates()).toBe(3);
  } finally { h.host.dispose(); }
});

test('host-ready supplies theme metadata on every supported Scope surface', () => {
  const h = harness();
  try {
    for (const surface of ['panel', 'page', 'status'] as const) {
      h.ready(palette(100_000), surface);
      expect(h.root.dataset.ocSurface).toBe(surface);
      expect(h.values.get('--oc-bg')).toBe('#0186a1');
      expect(h.values.get('font-family')).toBe('"Theme Sans 100000", sans-serif');
    }
  } finally { h.host.dispose(); }
});

test('unexpected missing host tokens clear previous declarations and permit current-theme CSS fallbacks', () => {
  const h = harness();
  try {
    const first = palette(100_000);
    for (const key of Object.keys(first.tokens) as Array<keyof HostThemeTokens>) {
      h.ready(first);
      const aliases = [...h.values].filter(([, value]) => value === first.tokens[key]).map(([name]) => name);
      const incomplete = palette(200_000);
      delete (incomplete.tokens as Partial<HostThemeTokens>)[key];
      h.ready(incomplete);
      for (const alias of aliases) expect(h.values.has(alias), alias).toBe(false);
      expect([...h.values.values()], key).not.toContain(first.tokens[key]);
      expect([...h.values.values()]).not.toContain('undefined');
      expect(h.root.style.colorScheme).toBe('dark');
    }
    h.ready(palette(300_000));
    expect(h.values.get('--oc-primary-text')).toBe('#0493f0');
  } finally { h.host.dispose(); }
});
