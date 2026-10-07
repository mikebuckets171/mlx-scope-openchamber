import { expect, test } from 'bun:test';
import { parseSnapshotV2 } from '../../../src/contract/snapshot.ts';
import { presentLive } from '../../present/live.ts';
import { SERVER_WIDE, type ScopeInput } from '../../present/scope.ts';
import { presentServer } from '../../present/server.ts';
import { presentStatusSection } from '../../present/status.ts';
import { fromSnapshot } from '../../present/reading.ts';
import { MOCK_NOW, MOCK_STATES, mockBody } from '../../testing/mock-states.ts';
import { esc, html } from '../html.ts';
import { frameCardMarkup, shellMarkup, TABS, tabsMarkup } from '../shell.ts';
import { liveMarkup } from './live.ts';
import { serverMarkup } from './server.ts';
import { statusHeight, statusMarkup } from './status.ts';
import { primaryTab } from './types.ts';

const snapshotOf = (state: string, patch: (body: Record<string, any>) => void = () => {}) => {
  const body = JSON.parse(JSON.stringify(mockBody(state))); patch(body);
  return parseSnapshotV2(body)!;
};
const inputOf = (state: string, patch?: (body: Record<string, any>) => void, extra: Partial<ScopeInput> = {}): ScopeInput => {
  const snapshot = snapshotOf(state, patch), last = snapshot.completions.items.at(-1) ?? null;
  return { now: MOCK_NOW, version: '2.0.0', snapshot, fresh: true, frame: null, paused: false, attribution: { kind: 'inferred' }, chatRuntime: null,
    last: last ? { completion: last, label: { kind: 'inferred' }, vsUsual: null, flag: null } : null, next: { kind: 'idle' }, samples: [], turnStartAt: null, ...extra };
};

test('every value is escaped: a hostile model name renders as text in every view', () => {
  const hostile = '<img src=x onerror=alert(1)>"\'&';
  const input = inputOf('decode', body => { body.runtime.request.model = hostile; body.runtime.residency[0].model = hostile; });
  const markup = [liveMarkup(presentLive(input), new Set()).markup, serverMarkup(presentServer(input.snapshot, MOCK_NOW), new Set()).markup].join('');
  expect(markup).not.toContain('<img');
  expect(markup).toContain(esc(hostile));
  expect(html`<b>${'<i>'}</b>${[html`<u>${'&'}</u>`]}${null}${false}${0}`.markup).toBe('<b>&lt;i&gt;</b><u>&amp;</u>0');
});

test('ⓘ disclosures are 24 px buttons with aria-expanded and aria-controls, their text in flow and hidden until opened', () => {
  const input = inputOf('decode'), closed = liveMarkup(presentLive(input), new Set()).markup;
  const buttons = [...closed.matchAll(/<button class="info"[^>]*aria-controls="([^"]+)"[^>]*>/g)];
  expect(buttons.length).toBeGreaterThanOrEqual(4);
  for (const [button, id] of buttons) {
    expect(button).toContain('aria-expanded="false"');
    expect(button).toMatch(/aria-label="About [^"]+"/);
    expect(closed).toMatch(new RegExp(`<div class="pop" id="${id}" role="note" hidden>`));
  }
  const open = liveMarkup(presentLive(input), new Set(['pop-live-attr'])).markup;
  expect(open).toContain('aria-expanded="true" aria-controls="pop-live-attr"');
  expect(open).toMatch(/<div class="pop" id="pop-live-attr" role="note"><strong>Likely this chat<\/strong>/);
});

test('every mock state renders every view without a raw placeholder', () => {
  for (const state of MOCK_STATES) {
    const input = inputOf(state), status = presentStatusSection({ now: MOCK_NOW, reading: fromSnapshot(input.snapshot!), snapshot: input.snapshot,
      attribution: SERVER_WIDE, turn: null, vsUsual: null, sparkline: null, chatIsLocal: true, expanded: false, tipDismissed: true, fresh: true });
    const markup = [liveMarkup(presentLive(input), new Set()), serverMarkup(presentServer(input.snapshot, MOCK_NOW), new Set()), statusMarkup(status)].map(item => item.markup).join('');
    expect(markup, state).not.toMatch(/undefined|NaN|\[object|VRAM/);
    expect(markup, state).toContain(`style="height:${statusHeight(status)}px"`);
    expect(statusMarkup(status, true).markup, `${state} compact`).toContain(`style="height:${statusHeight(status, true)}px"`);
  }
});

test('two primary tabs keep secondary workspaces in the correct accessible parent', () => {
  expect(TABS.map(([, label]) => label)).toEqual(['Live', 'History']);
  for (const [view, parent] of [['live', 'live'], ['server', 'live'], ['history', 'history'], ['captures', 'history']] as const) {
    expect(primaryTab(view)).toBe(parent);
    const markup = tabsMarkup(TABS, primaryTab(view)).markup;
    expect([...markup.matchAll(/tabindex="(-?\d)"/g)].map(match => match[1])).toEqual(parent === 'live' ? ['0', '-1'] : ['-1', '0']);
    expect(markup).toContain(`id="tab-${parent}" data-tab="${parent}" aria-controls="panel-${parent}" aria-selected="true"`);
  }
  expect(shellMarkup().markup.match(/role="tabpanel"/g)).toHaveLength(2);
  expect(shellMarkup().markup).toContain('aria-labelledby="captures-title"');
});

test('runtime diagnostics are available in a disclosure without displacing server measurements', () => {
  const view = presentServer(snapshotOf('decode'), MOCK_NOW), closed = serverMarkup(view, new Set()).markup;
  expect(closed).toContain('<details class="runtime-details" id="server-runtime-details">');
  expect(closed).toContain('data-key="server-memory"');
  expect(closed.indexOf('data-key="server-memory"')).toBeLessThan(closed.indexOf('id="server-runtime-details"'));
  expect(closed).toContain('per-request speed');
  expect(serverMarkup(view, new Set(['server-runtime-details'])).markup).toContain('id="server-runtime-details" open>');
});

test('needs approval lists every exec path as code; needs restart gives the two S11 steps', () => {
  const approval = frameCardMarkup('approval').markup, restart = frameCardMarkup('restart').markup;
  expect(approval).toContain('<code>/usr/sbin/ioreg</code>');
  expect(approval).toContain('<code>~/.cache/lm-studio/bin/lms</code>');
  expect(approval).not.toMatch(/sessions|chat titles/i);
  expect(restart).toContain('<li>Pause it, then resume it.</li>');
});
