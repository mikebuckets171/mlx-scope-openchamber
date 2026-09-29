// Captures docs/design/2.0-mock-shots/ from 2.0-mock.html with Playwright (Chromium) and checks the mock:
// embedded fixtures match 2.0-mock-fixtures.json and the contract shapes; no horizontal overflow; Work Status heights, fit
// and model names; attribution and basis labels; no "VRAM", no GPU alert; charts only where readings exist; ⓘ targets,
// no tooltip-only content, labelled charts and tabs; text ≥ 10 px and ≥ 4.5:1 contrast in both themes; one callout and
// no repeated figure per view; and the shot budget.
// Usage: node docs/design/shoot-2.0-mock.mjs [--sync] [--check-only]
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mockPath = join(here, '2.0-mock.html'), fixturesPath = join(here, '2.0-mock-fixtures.json'), outDir = join(here, '2.0-mock-shots');
const EMBED = /(<script type="application\/json" id="fixtures">)([\s\S]*?)(<\/script>)/;
const MAX_FILES = 130, MAX_MB = 14;
const failures = [];
const fail = message => failures.push(message);

const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));
let mock = readFileSync(mockPath, 'utf8');
if (process.argv.includes('--sync')) { mock = mock.replace(EMBED, (_, open, _old, close) => open + JSON.stringify(fixtures) + close); writeFileSync(mockPath, mock); }
if (JSON.stringify(JSON.parse(EMBED.exec(mock)[2])) !== JSON.stringify(fixtures)) fail('embedded fixtures differ from 2.0-mock-fixtures.json (run with --sync)');
if (/(?:src|href)\s*=\s*["']?(?:https?:)?\/\/|<link\b|@import|url\(/i.test(mock.replace(EMBED, ''))) fail('mock references an external asset');

// Fixture shape checks against 2.0-contract.md: units, the honesty invariant, the route size limit, no class A keys.
// A null in a merged fixture means the field is absent.
const merge = (a, b) => b === undefined ? a : b === null || typeof b !== 'object' || Array.isArray(b) ? b
  : Object.fromEntries([...new Set([...Object.keys(a ?? {}), ...Object.keys(b)])].map(k => [k, merge(a?.[k], b[k])]));
const HONESTY = {
  'runtime.request.decodeTps': 'request.decodeRate', 'runtime.request.prefillTps': 'request.prefillRate', 'runtime.request.prefillFraction': 'request.prefillProgress',
  'runtime.request.prefillEtaMs': 'request.prefillEta', 'runtime.request.ttftMs': 'request.ttft', 'runtime.request.promptTokens': 'request.tokens',
  'runtime.request.elapsedMs': 'request.elapsed', 'runtime.request.contextUsedTokens': 'request.context', 'runtime.server.active': 'server.requests',
  'runtime.server.averages': 'server.averages', 'runtime.server.histograms': 'server.latency', 'runtime.server.cache': 'server.cache',
  'runtime.server.speculative': 'server.speculative', 'runtime.server.rates': 'server.rates', 'runtime.memory.processBytes': 'server.memory.process',
  'runtime.memory.modelBytes': 'server.memory.model', 'runtime.memory.metalBytes': 'server.memory.metal', 'runtime.memory.ceilingBytes': 'server.memory.ceiling',
  'runtime.residency.0': 'server.residency', 'runtime.slots.0': 'server.slots', 'runtime.catalog.0': 'server.catalog', 'runtime.engines.0': 'server.engines',
  'completions.items.0': 'server.completions', 'host.cpuFraction': 'host.cpu', 'host.memUsedBytes': 'host.memory', 'host.mac.swapUsedBytes': 'host.swap',
  'host.mac.pressureLevel': 'host.pressure', 'host.mac.wiredLimitBytes': 'host.wiredLimit', 'host.gpu.busyFraction': 'host.gpuBusy',
  'host.gpu.allocBytes': 'host.gpuMemory', 'host.thermal': 'host.thermal', 'host.runtimeProcess': 'host.footprint', 'host.power': 'host.power',
};
const TOP = ['contractVersion', 'serverNow', 'service', 'connection', 'status', 'capabilities', 'runtime', 'host', 'completions', 'marksHead', 'alerts', 'alertLog', 'lease', 'nextPollMs'];
const at = (o, path) => path.split('.').reduce((v, k) => v?.[k], o);
const walk = (value, path, visit) => { visit(path, value); if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, visit); };
const snapshots = Object.entries(fixtures.states).map(([id, st]) => [id, merge(fixtures.snapshots[st.snapshot], st.patch)]);
for (const [id, snap] of snapshots) {
  for (const key of TOP) if (!(key in snap)) fail(`fixture ${id}: missing ${key}`);
  if (snap.contractVersion !== 2) fail(`fixture ${id}: contractVersion ${snap.contractVersion}`);
  if (JSON.stringify(snap).length >= 256000) fail(`fixture ${id}: body over 256,000 chars`);
  for (const [path, capability] of Object.entries(HONESTY)) if (at(snap, path) != null && !snap.capabilities[capability]) fail(`fixture ${id}: ${path} without capability ${capability}`);
  walk(snap, '', (path, v) => {
    const key = path.split('.').at(-1);
    if (v == null) return;
    if (/Bytes$/.test(key) && !Number.isSafeInteger(v)) fail(`fixture ${id}: ${path} is not an integer byte count`);
    if (/Fraction$/.test(key) && !(v >= 0 && v <= 1)) fail(`fixture ${id}: ${path} outside 0…1`);
    if (/^(pid|api_?key|cookie|sessionId|sessionTitle|title|directory|path|prompt|generation_prompt|last_crash_trace)$/i.test(key)) fail(`fixture ${id}: forbidden key ${path}`);
  });
  if (snap.alerts.some(a => /gpu/i.test(a.id))) fail(`fixture ${id}: GPU alert`);
}
// Charts never invent readings: a bucket with no sample is null, and min/last are real samples (never a 0 for "idle").
for (const [name, t] of [['trend', fixtures.trend], ['trendFresh', fixtures.trendFresh]]) {
  const b = t.series.decodeTps.buckets;
  if (b.length > 180) fail(`${name} has more than 180 buckets`);
  if (b.some(x => x && (x.length !== 3 || x.some(v => !(v > 0)) || x[0] > x[2] || x[2] > x[1]))) fail(`${name}: a bucket is not [min ≤ last ≤ max] of real readings (idle must be null)`);
  if (JSON.stringify(t).length >= 256000) fail(`${name} over 256,000 chars`);
}
if (JSON.stringify(fixtures.usage).length >= 256000) fail('usage fixture over 256,000 chars');
if (fixtures.usage.models.length > 50) fail('usage lists more than 50 models');
for (const row of [...fixtures.panel.ledger, ...fixtures.panel.captures]) if (row.attr && ['server', 'withheld'].includes(row.attr.label) && !row.attr.reason) fail(`ledger or capture row without a server-wide reason: ${JSON.stringify(row.attr)}`);
const ts = fixtures.panel.turnStats;
for (const [k, t] of Object.entries(ts)) if (t.endedAt && t.endedAt - t.startedAt !== t.wholeMs) fail(`turnStats.${k}: endedAt − startedAt ≠ wholeMs`);
for (const [k, t] of Object.entries(ts)) if (t.modelMs != null && t.modelMs + t.waitMs !== t.wholeMs) fail(`turnStats.${k}: model + wait ≠ turn time`);

const STATES = Object.keys(fixtures.states);
const LIVE_STATES = ['withheld-chats', 'withheld-subagent', 'other-provider', 'armed-refusal', 'first-readings', 'prefill', 'prefill-stall', 'paused', 'next-armed', 'next-measuring', 'next-result',
  'splash-recovering', 'splash-stale', 'splash-not-admitting', 'offline', 'runtime-changed', 'detecting', 'unconfigured', 'contract-mismatch', 'needs-approval', 'admin-unauthorized',
  'pressure', 'pressure-critical', 'thermal', 'model-unloaded', 'memory-guard'];
const SERVER_STATES = ['llama', 'llama-sleeping', 'llama-metrics', 'ollama', 'bionic', 'lms-unavailable'];
const HISTORY_STATES = ['storage-full', 'history-empty', 'recording-paused', 'clear-confirm'];
const WS_VARIANTS = ['decode', 'idle', 'prefill', 'first', 'alert', 'withheld', 'measuring', 'armed', 'offline', 'recovering', 'approval', 'nonlocal', 'tip', 'firstrun',
  'turnstats', 'turnstats-live', 'turnstats-withheld', 'turnstats-omlx'];
for (const s of [...LIVE_STATES, ...SERVER_STATES, ...HISTORY_STATES]) if (!STATES.includes(s)) fail(`unknown state ${s}`);

const rail = (tab, state, theme, w, extra = {}) => ({ w, params: { surface: 'rail', tab, state, theme, ...extra } });
const shots = [];
for (const theme of ['dark', 'light']) for (const w of [320, 430]) for (const tab of ['live', 'server', 'history', 'captures'])
  shots.push({ name: `rail-${tab}-${theme}-${w}`, ...rail(tab, 'decode', theme, w) });
shots.push({ name: 'rail-live-popover-dark-430', ...rail('live', 'decode', 'dark', 430, { pop: 'attr' }) });
shots.push({ name: 'rail-live-details-open-dark-320', element: '.machine', ...rail('live', 'decode', 'dark', 320, { details: 'open' }) });
shots.push({ name: 'decision-short-labels-dark-320', element: '.machine', ...rail('live', 'decode', 'dark', 320, { details: 'open', labels: 'short' }) });
for (const [name, state, theme] of [['rail-compact-dark-320', 'decode', 'dark'], ['rail-compact-light-320', 'decode', 'light'], ['rail-compact-alert-dark-320', 'pressure', 'dark']])
  shots.push({ name, ...rail('live', state, theme, 320, { compact: 1 }) });
for (const state of LIVE_STATES) shots.push({ name: `state-${state}-dark-320`, ...rail('live', state, 'dark', 320) });
for (const state of ['pressure', 'pressure-critical', 'offline', 'next-result']) shots.push({ name: `state-${state}-light-320`, ...rail('live', state, 'light', 320) });
for (const state of SERVER_STATES) shots.push({ name: `state-${state}-server-dark-320`, ...rail('server', state, 'dark', 320) });
shots.push({ name: 'state-llama-server-light-320', ...rail('server', 'llama', 'light', 320) });
for (const state of HISTORY_STATES) shots.push({ name: `state-${state}-history-dark-320`, ...rail('history', state, 'dark', 320) });
shots.push({ name: 'state-next-armed-captures-dark-320', ...rail('captures', 'next-armed', 'dark', 320) });
for (const theme of ['dark', 'light']) for (const variant of WS_VARIANTS)
  shots.push({ name: `status-${variant}-${theme}-280`, w: 320, scale: 2, element: '.ws-shot', params: { surface: 'status', variant, theme } });
shots.push({ name: 'status-board-light', w: 1100, params: { surface: 'status', theme: 'light' } });
for (const theme of ['dark', 'light']) shots.push({ name: `page-${theme}-1160`, w: 1160, params: { surface: 'page', state: 'decode', theme } });
for (const state of ['pressure', 'offline', 'needs-approval']) shots.push({ name: `page-${state}-dark-1160`, w: 1160, params: { surface: 'page', state, theme: 'dark' } });

// Extra check-only frames: every state on every rail tab (dark 320), every state's Live view in light and at 430, and the page in every state.
const checks = [];
for (const state of STATES) {
  for (const tab of ['live', 'server', 'history', 'captures']) checks.push(rail(tab, state, 'dark', 320));
  checks.push(rail('live', state, 'light', 320), rail('server', state, 'light', 320), rail('live', state, 'dark', 430));
  checks.push({ w: 1160, params: { surface: 'page', state, theme: 'dark' } });
  checks.push(rail('live', state, 'dark', 320, { compact: 1 }));
}
for (const theme of ['dark', 'light']) checks.push({ w: 1100, params: { surface: 'status', theme } }, { w: 1300, params: { surface: 'board', theme } });

const inspect = openAll => {
  const vw = innerWidth, problems = [];
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const board = el => el.closest('.board, .ws-head, .ws-caption, .annotation, .host-rows, .host-collapsed');
  if (openAll) for (const b of document.querySelectorAll('button[aria-controls]:not([role="tab"])')) { b.setAttribute('aria-expanded', 'true'); document.getElementById(b.getAttribute('aria-controls')).hidden = false; }
  const clips = el => { for (let a = el.parentElement; a; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o !== 'visible') return a; } return null; };
  if (document.documentElement.scrollWidth > vw) problems.push(`page scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= vw + .5) continue;
    const c = clips(el);
    if (c && c.getBoundingClientRect().right <= vw + .5) continue;
    problems.push(`overflow: <${el.tagName.toLowerCase()} class="${el.className?.baseVal ?? el.className}"> right ${Math.round(r.right)} > ${vw}`);
  }
  // Text: at least 10 px and 4.5:1 against what is behind it (backgrounds composited up the tree).
  const parse = str => { let m = /^rgba?\(([^)]+)\)$/.exec(str); if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0] / 255, p[1] / 255, p[2] / 255, p[3] ?? 1]; }
    m = /^color\(srgb ([^)]+)\)$/.exec(str); if (m) { const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; } return null; };
  const over = (top, base) => [0, 1, 2].map(i => top[i] * top[3] + base[i] * (1 - top[3]));
  const lum = c => { const f = v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const behind = el => {
    const chain = []; for (let a = el; a; a = a.parentElement) chain.unshift(a);
    let base = [1, 1, 1];
    for (const a of chain) { const cs = getComputedStyle(a), img = /(rgba?\([^)]*\)|color\(srgb[^)]*\))/.exec(cs.backgroundImage);
      if (img && !/repeating/.test(cs.backgroundImage)) { const c = parse(img[1]); if (c) base = over(c, base); }
      const c = parse(cs.backgroundColor); if (c) base = over(c, base); }
    return base;
  };
  for (const el of document.querySelectorAll('body *')) {
    if (board(el) || !visible(el) || el.closest('.sr-only, svg') || el.disabled || el.closest('[aria-hidden="true"]')) continue;
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    if (!own || /^[\s·•—–\-→›┊|:()+%]*$/.test(own)) continue;
    const cs = getComputedStyle(el), size = parseFloat(cs.fontSize);
    if (size < 10) problems.push(`text under 10 px (${size.toFixed(2)}): "${own.slice(0, 30)}"`);
    let alpha = 1; for (let a = el; a; a = a.parentElement) alpha *= Number(getComputedStyle(a).opacity);
    const fg = parse(cs.color); if (!fg) continue;
    const bg = behind(el), text = over([fg[0], fg[1], fg[2], fg[3] * alpha], bg), cr = ratio(text, bg);
    if (cr < 4.5 && !(size >= 18.66 || (size >= 14 && Number(cs.fontWeight) >= 700))) problems.push(`contrast ${cr.toFixed(2)}:1 for "${own.slice(0, 30)}" (${cs.color})`);
  }
  if (openAll) return problems;
  const text = document.body.innerText;
  if (/vram/i.test(text)) problems.push('says VRAM');
  for (const chip of document.querySelectorAll('.chip[data-attr]')) {
    if (!visible(chip)) continue;
    const t = chip.textContent.trim(), desc = chip.getAttribute('aria-describedby');
    const describedOk = t === 'Server-wide' && desc && document.getElementById(desc)?.textContent.includes(chip.dataset.reason) && visible(document.getElementById(desc));
    if (!/^(This chat · inferred|Next reply · armed|Server-wide · .+)$/.test(t) && !describedOk) problems.push(`attribution chip "${t}" (server-wide needs its reason)`);
    if (chip.scrollWidth > chip.clientWidth + 1) problems.push(`attribution chip truncated: "${t}"`);
  }
  if (/This chat(?! · inferred| uses)/.test(text)) problems.push('"This chat" without "inferred"');
  for (const el of document.querySelectorAll('[data-basis]:not([data-basis="reported"])')) {
    if (!visible(el) || el.classList.contains('chip')) continue;
    const label = el.querySelector('.basis') ?? (el.nextElementSibling?.classList.contains('basis') ? el.nextElementSibling : null);
    if (!label?.textContent.trim()) problems.push(`value without basis label: "${el.textContent.trim().slice(0, 40)}"`);
  }
  // Every value cell declares its basis, so the rule is applied everywhere, not only where someone remembered.
  for (const el of document.querySelectorAll('.metrics > div > strong, .ts-rows dd, .reply-values > span:not(.chip), .led-main > .val, .prefill-remaining'))
    if (!el.dataset.basis) problems.push(`value without a declared basis: "${el.textContent.trim().slice(0, 30)}"`);
  for (const el of document.querySelectorAll('.led-main')) for (const m of el.innerText.matchAll(/token-weighted/g)) if (!el.querySelector('[data-basis="derived"]')) problems.push('token-weighted rate not marked derived');
  for (const a of document.querySelectorAll('.connection-diagnosis, .ws-alert')) if (/GPU/.test(a.textContent)) problems.push(`GPU alert: "${a.textContent.trim().slice(0, 40)}"`);
  // One callout per view (the rest behind "N more"), and no figure repeated within a view.
  for (const v of document.querySelectorAll('.view, .ws')) {
    if (!visible(v)) continue;
    const top = [...v.children].filter(c => c.classList.contains('connection-diagnosis') && visible(c));
    if (top.length > 1) problems.push(`${top.length} callouts stacked in one view`);
    // Figures with their unit, outside list rows (each row is its own reply, slot or model).
    const parts = [], walker = document.createTreeWalker(v, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (visible(n.parentElement) && !n.parentElement.closest('li, .sr-only, [aria-hidden="true"]')) parts.push(n.textContent);
    const nums = (parts.join(' ').match(/(?<![\d.,:])(?:\d{1,3}(?:,\d{3})+|\d+\.\d+)(?![\d.,])(?:\s?(?:K|M|%|GiB|MiB|KiB|W|tok\/s)(?![A-Za-z]))?/g) ?? []), seen = {};
    for (const n of nums) seen[n] = (seen[n] ?? 0) + 1;
    for (const [n, c] of Object.entries(seen)) if (c > 1) problems.push(`"${n}" appears ${c} times in one view`);
  }
  // ⓘ: a 24 px disclosure with a real target; nothing explanatory in a tooltip.
  for (const b of document.querySelectorAll('.info')) {
    const r = b.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) problems.push(`ⓘ target ${r.width}×${r.height} px`);
    if (!b.hasAttribute('aria-expanded') || !document.getElementById(b.getAttribute('aria-controls'))) problems.push('ⓘ without aria-expanded/aria-controls target');
  }
  for (const el of document.querySelectorAll('[title]:not(iframe)')) problems.push(`tooltip-only text on <${el.tagName.toLowerCase()}>: "${el.title.slice(0, 30)}"`);
  // Charts carry a role and a summary; decorative SVG sits inside one or inside a control.
  for (const c of document.querySelectorAll('.plot, .ws-spark, .usage-bars')) if (c.getAttribute('role') !== 'img' || !c.getAttribute('aria-label')) problems.push(`chart without role="img" and a summary: ${c.className}`);
  for (const svg of document.querySelectorAll('svg')) if (!svg.closest('[role="img"][aria-label], button, .brand') && svg.getAttribute('aria-hidden') !== 'true') problems.push('unlabelled svg');
  const trace = document.querySelector('.hero-card .trace');
  if (trace && Number(/^M[\d.]+ ([\d.]+)/.exec(trace.getAttribute('d'))?.[1]) > 100) problems.push('live chart starts at zero instead of the first reading');
  // Tabs: aria-controls to a real panel, roving tabindex.
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const p = document.getElementById(tab.getAttribute('aria-controls'));
    if (!p || p.getAttribute('role') !== 'tabpanel' || p.getAttribute('aria-labelledby') !== tab.id) problems.push(`tab ${tab.id} without its panel`);
    if (tab.tabIndex !== (tab.getAttribute('aria-selected') === 'true' ? 0 : -1)) problems.push(`tab ${tab.id} breaks roving tabindex`);
  }
  // The glance: exact heights, nothing spills, and the model name is never squeezed.
  for (const ws of document.querySelectorAll('.ws')) {
    const want = Number(ws.style.height.replace('px', ''));
    if (ws.clientHeight !== want) problems.push(`status ${ws.dataset.variant}: height ${ws.clientHeight} ≠ ${want}`);
    if (ws.scrollHeight > ws.clientHeight) problems.push(`status ${ws.dataset.variant}: content ${ws.scrollHeight} px overflows ${ws.clientHeight} px`);
    if (want > 200) problems.push(`status ${ws.dataset.variant}: taller than 200 px`);
    for (const line of ws.querySelectorAll('.ws-line, .ts-head')) if (line.scrollWidth > line.clientWidth + 1) problems.push(`status ${ws.dataset.variant}: a line overflows (${line.scrollWidth} > ${line.clientWidth})`);
    for (const m of ws.querySelectorAll('.ws-model')) if (m.scrollWidth > m.clientWidth + 1) problems.push(`status ${ws.dataset.variant}: model name squeezed to ${m.clientWidth} px ("${m.textContent}")`);
    for (const t of ws.querySelectorAll('.ws-grow, .ws-muted, .ts-reason')) if (t.scrollWidth > t.clientWidth + 1) problems.push(`status ${ws.dataset.variant}: text truncated ("${t.textContent.trim()}")`);
    for (const dd of ws.querySelectorAll('.ts-rows dd')) if (dd.scrollWidth > dd.clientWidth + 1) problems.push(`status ${ws.dataset.variant}: row value truncated ("${dd.textContent}")`);
  }
  // Nothing the fixtures hold is cut off by an ellipsis.
  for (const el of document.querySelectorAll('body *')) if (!board(el) && visible(el) && getComputedStyle(el).textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1)
    problems.push(`text cut off: "${el.textContent.trim().slice(0, 40)}"`);
  const compact = document.querySelector('.scope[data-compact="true"]');
  if (compact && compact.scrollHeight > 160) problems.push(`compact rail ${compact.scrollHeight} px tall (limit 160)`);
  return problems;
};

// State-specific assertions: the critique's must-fix items stay fixed.
const countOnce = ({ source, what }) => { const n = (document.body.innerText.match(new RegExp(source, 'g')) ?? []).length; return n === 1 || `${what} appears ${n} times`; };
const once = (source, what) => [countOnce, { source, what }];
const ASSERT = [
  [rail('captures', 'decode', 'dark', 320), () => !document.querySelector('.capture-card .chip[data-attr="armed"]') || 'Captures shows “Next reply · armed” while nothing is armed'],
  [rail('captures', 'next-armed', 'dark', 320), () => !!document.querySelector('.capture-card .chip[data-attr="armed"]') || 'Captures hides the armed chip while armed'],
  [rail('live', 'next-measuring', 'dark', 320), () => { const row = document.querySelector('.next-row'); return !!row && !/tok|\d\.\d/.test(row.textContent) && document.querySelectorAll('.chip[data-attr="armed"]').length === 1 || 'measuring strip repeats numbers or the armed chip'; }],
  [rail('live', 'first-readings', 'dark', 320), () => !document.querySelector('.hero-card .plot') && /starts after 2 readings/.test(document.body.innerText) || 'live chart drawn before 2 readings'],
  [{ w: 320, params: { surface: 'status', variant: 'first', theme: 'dark' } }, () => !document.querySelector('.ws-spark') || 'sparkline drawn before 2 readings'],
  [rail('live', 'offline', 'dark', 320), ...once('stopped responding', '“stopped responding”')],
  [rail('live', 'offline', 'dark', 320), () => !/Offline/.test(document.querySelector('.view').innerText) || 'offline repeated inside the view'],
  [rail('live', 'splash-recovering', 'dark', 320), ...once('every 30 s', '“every 30 s”')],
  [rail('live', 'pressure', 'dark', 320), ...once('[Ss]lower', '“slower”')],
  [rail('live', 'pressure', 'dark', 320), () => !/usual 25\.7/.test(document.body.innerText) || 'regression explained inline instead of in the ⓘ'],
  [rail('live', 'decode', 'dark', 320), () => !document.querySelector('.host-details[open]') || 'Mac details open by default'],
  [rail('live', 'decode', 'dark', 320), () => { document.querySelector('.hero-card .info').click(); return /Scope has seen every reading since the reply started/.test(document.body.innerText) || 'live ⓘ says the whole reply was seen'; }],
  [rail('live', 'idle', 'dark', 320), () => { document.querySelector('.reply-strip .info').click(); return !/so far/.test(document.querySelector('.reply-strip').innerText) || 'finished reply uses the live wording'; }],
  [rail('live', 'thermal', 'dark', 320), () => document.querySelector('.mac-row .level:not([data-level="normal"])')?.textContent === 'Heavy' || 'thermal row not warning at Heavy'],
  [{ w: 320, params: { surface: 'status', variant: 'alert', theme: 'dark' } }, () => { const a = document.querySelector('.ws-alert'); return a?.dataset.severity === 'warning' && /pressure/.test(a.textContent) && !/Pressure warning/.test(document.querySelector('.ws').innerText) || 'alert line is not the most severe alert, or repeats a chip'; }],
  [rail('live', 'decode', 'light', 320), () => getComputedStyle(document.querySelector('.chip[data-attr="inferred"]')).color],
  [rail('live', 'offline', 'light', 320), () => getComputedStyle(document.querySelector('.chip[data-attr="inferred"]')).color],
];

const url = params => `${pathToFileURL(mockPath).href}?${new URLSearchParams(params)}`;
const browser = await chromium.launch();
const open = async ({ w, params, scale = 1 }) => {
  const page = await browser.newPage({ viewport: { width: w, height: 800 }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!/^(file|data|about):/.test(request.url())) errors.push(`network request ${request.url()}`); });
  await page.goto(url(params));
  await page.waitForSelector('body[data-ready="true"]', { timeout: 5000 }).catch(() => errors.push('never became ready'));
  return { page, errors };
};
const label = params => new URLSearchParams(params).toString();
let frames = 0;
for (const target of [...shots, ...checks]) {
  const { page, errors } = await open(target);
  for (const e of errors) fail(`${label(target.params)}: script error ${e}`);
  if (target.params.surface !== 'board') {
    for (const p of await page.evaluate(inspect, false)) fail(`${label(target.params)}: ${p}`);
    for (const p of await page.evaluate(inspect, true)) fail(`${label(target.params)} (ⓘ open): ${p}`);
  }
  frames++;
  await page.close();
}
const colours = [];
for (const [target, fn, arg] of ASSERT) {
  const { page } = await open(target);
  const result = await page.evaluate(fn, arg);
  if (typeof result === 'string' && /^color|^rgb/.test(result)) colours.push(result);
  else if (result !== true) fail(`${label(target.params)}: ${result}`);
  await page.close();
}
if (new Set(colours).size !== 1) fail(`attribution chip colour follows the phase: ${[...new Set(colours)].join(' vs ')}`);
if (!process.argv.includes('--check-only')) {
  mkdirSync(outDir, { recursive: true });
  for (const file of readdirSync(outDir)) if (file.endsWith('.png')) rmSync(join(outDir, file));
  for (const shot of shots) {
    const { page } = await open(shot);
    const path = join(outDir, `${shot.name}.png`);
    if (shot.element) await page.locator(shot.element).first().screenshot({ path });
    else await page.screenshot({ path, fullPage: true });
    await page.close();
  }
  const files = readdirSync(outDir).filter(file => file.endsWith('.png'));
  const bytes = files.reduce((sum, file) => sum + statSync(join(outDir, file)).size, 0);
  if (files.length !== shots.length) fail(`${files.length} screenshots for ${shots.length} shots`);
  if (files.length > MAX_FILES) fail(`${files.length} screenshots (limit ${MAX_FILES})`);
  if (bytes > MAX_MB * 1024 * 1024) fail(`${(bytes / 1048576).toFixed(2)} MB of screenshots (limit ${MAX_MB} MB)`);
  console.log(`${files.length} screenshots, ${(bytes / 1048576).toFixed(2)} MB in docs/design/2.0-mock-shots/`);
}
await browser.close();
if (failures.length) { console.error(`FAIL (${failures.length}):\n${[...new Set(failures)].slice(0, 150).join('\n')}`); process.exit(1); }
console.log(`PASS: ${frames} frames and ${ASSERT.length} assertions checked (overflow, labels, basis, contrast, type size, ⓘ, charts, tabs, status heights, fixtures in sync).`);
