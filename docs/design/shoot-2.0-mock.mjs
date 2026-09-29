// Captures docs/design/2.0-mock-shots/ from 2.0-mock.html with Playwright (Chromium) and checks the mock:
// embedded fixtures match 2.0-mock-fixtures.json, no horizontal overflow at 320 px, Work Status heights and fit,
// attribution and basis labels, no "VRAM", no GPU alert, and the shot budget (≤ 40 PNGs, ≤ 5 MB).
// Usage: node docs/design/shoot-2.0-mock.mjs [--sync] [--check-only]
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mockPath = join(here, '2.0-mock.html'), fixturesPath = join(here, '2.0-mock-fixtures.json'), outDir = join(here, '2.0-mock-shots');
const EMBED = /(<script type="application\/json" id="fixtures">)([\s\S]*?)(<\/script>)/;
const failures = [];
const fail = message => failures.push(message);

const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));
let mock = readFileSync(mockPath, 'utf8');
if (process.argv.includes('--sync')) { mock = mock.replace(EMBED, (_, open, _old, close) => open + JSON.stringify(fixtures) + close); writeFileSync(mockPath, mock); }
if (JSON.stringify(JSON.parse(EMBED.exec(mock)[2])) !== JSON.stringify(fixtures)) fail('embedded fixtures differ from 2.0-mock-fixtures.json (run with --sync)');
if (/(?:src|href)\s*=\s*["']?(?:https?:)?\/\/|<link\b|@import|url\(/i.test(mock.replace(EMBED, ''))) fail('mock references an external asset');

// Fixture shape checks against 2.0-contract.md: units, the honesty invariant, the route size limit, no class A keys.
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
    if (/Bytes$/.test(key) && !Number.isSafeInteger(v)) fail(`fixture ${id}: ${path} is not an integer byte count`);
    if (/Fraction$/.test(key) && !(v >= 0 && v <= 1)) fail(`fixture ${id}: ${path} outside 0…1`);
    if (/^(pid|api_?key|cookie|sessionId|sessionTitle|title|directory|path|prompt|generation_prompt|last_crash_trace)$/i.test(key)) fail(`fixture ${id}: forbidden key ${path}`);
  });
  if (snap.alerts.some(a => /gpu/i.test(a.id))) fail(`fixture ${id}: GPU alert`);
}
for (const extra of [fixtures.trend, fixtures.usage]) if (JSON.stringify(extra).length >= 256000) fail('trend or usage fixture over 256,000 chars');
if (fixtures.trend.series.decodeTps.buckets.length > 180) fail('trend has more than 180 buckets');
if (fixtures.usage.models.length > 50) fail('usage lists more than 50 models');

const rail = (tab, state, theme, w, extra = {}) =>({ w, params: { surface: 'rail', tab, state, theme, ...extra } });
const shots = [];
for (const theme of ['dark', 'light']) for (const w of [320, 430]) for (const tab of ['live', 'server', 'history', 'captures'])
  shots.push({ name: `rail-${tab}-${theme}-${w}`, ...rail(tab, 'decode', theme, w, tab === 'live' && w === 430 ? { pop: 'attr' } : {}) });
for (const state of ['withheld-chats', 'withheld-subagent', 'prefill', 'next-armed', 'next-measuring', 'next-result', 'splash-recovering', 'offline', 'needs-approval', 'pressure'])
  shots.push({ name: `state-${state}-dark-320`, ...rail('live', state, 'dark', 320) });
for (const state of ['llama', 'ollama', 'bionic']) shots.push({ name: `state-${state}-server-dark-320`, ...rail('server', state, 'dark', 320) });
shots.push({ name: 'state-storage-full-history-dark-320', ...rail('history', 'storage-full', 'dark', 320) });
for (const variant of ['decode', 'idle', 'alert', 'nonlocal', 'turnstats', 'tip'])
  shots.push({ name: `status-${variant}-dark-280`, w: 320, scale: 2, element: '.ws-shot', params: { surface: 'status', variant, theme: 'dark' } });
shots.push({ name: 'status-board-light', w: 1100, params: { surface: 'status', theme: 'light' } });
for (const theme of ['dark', 'light']) shots.push({ name: `page-${theme}-1160`, w: 1160, params: { surface: 'page', state: 'decode', theme } });

// Extra check-only frames: every state on every rail tab at 320, plus the status variants not shot.
const checks = [];
for (const state of Object.keys(fixtures.states)) for (const tab of ['live', 'server', 'history', 'captures']) checks.push(rail(tab, state, 'dark', 320));
for (const variant of ['prefill', 'firstrun']) checks.push({ w: 320, params: { surface: 'status', variant, theme: 'dark' } });
checks.push({ w: 1160, params: { surface: 'board', theme: 'dark' } });

const inspect = () => {
  const vw = innerWidth, problems = [];
  const clips = el => { for (let a = el.parentElement; a; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o !== 'visible') return a; } return null; };
  if (document.documentElement.scrollWidth > vw) problems.push(`page scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= vw + .5) continue;
    const c = clips(el);
    if (c && c.getBoundingClientRect().right <= vw + .5) continue;
    problems.push(`overflow: <${el.tagName.toLowerCase()} class="${el.className?.baseVal ?? el.className}"> right ${Math.round(r.right)} > ${vw}`);
  }
  const text = document.body.innerText;
  if (/vram/i.test(text)) problems.push('says VRAM');
  for (const chip of document.querySelectorAll('.attr-chip')) {
    const t = chip.textContent.trim();
    if (!/^(This chat · inferred|Next reply · armed|Server-wide( · .+)?)$/.test(t)) problems.push(`attribution chip "${t}"`);
    if (chip.scrollWidth > chip.clientWidth + 1) problems.push(`attribution chip truncated: "${t}"`);
  }
  if (/This chat(?! · inferred| uses)/.test(text.replace(/this chat/g, ''))) problems.push('"This chat" without "inferred"');
  for (const el of document.querySelectorAll('[data-basis]:not([data-basis="reported"])')) {
    const label = el.querySelector('.basis') ?? (el.nextElementSibling?.classList.contains('basis') ? el.nextElementSibling : null);
    if (!label?.textContent.trim()) problems.push(`value without basis label: "${el.textContent.trim().slice(0, 40)}"`);
  }
  for (const a of document.querySelectorAll('.alert, .ws-alert')) if (/GPU/.test(a.textContent)) problems.push(`GPU alert: "${a.textContent.trim().slice(0, 40)}"`);
  for (const ws of document.querySelectorAll('.ws')) {
    const want = Number(ws.style.height.replace('px', ''));
    if (ws.clientHeight !== want) problems.push(`status ${ws.dataset.variant}: height ${ws.clientHeight} ≠ ${want}`);
    if (ws.scrollHeight > ws.clientHeight) problems.push(`status ${ws.dataset.variant}: content ${ws.scrollHeight} px overflows ${ws.clientHeight} px`);
    if (ws.dataset.variant === 'turnstats' && want > 200) problems.push('Turn stats replacement taller than 200 px');
    for (const line of ws.querySelectorAll('.ws-line, .ts-head')) if (line.scrollWidth > line.clientWidth + 1) problems.push(`status ${ws.dataset.variant}: a line overflows (${line.scrollWidth} > ${line.clientWidth})`);
  }
  return problems;
};

const url = params => `${pathToFileURL(mockPath).href}?${new URLSearchParams(params)}`;
const browser = await chromium.launch();
const open = async ({ w, params, scale = 1 }) => {
  const page = await browser.newPage({ viewport: { width: w, height: 800 }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!/^(file|data|about):/.test(request.url())) errors.push(`network request ${request.url()}`); });
  await page.goto(url(params));
  await page.waitForSelector('body[data-ready="true"]');
  return { page, errors };
};
const label = params => new URLSearchParams(params).toString();
for (const target of [...shots, ...checks]) {
  const { page, errors } = await open(target);
  for (const e of errors) fail(`${label(target.params)}: script error ${e}`);
  if (target.params.surface !== 'board') for (const p of await page.evaluate(inspect)) fail(`${label(target.params)}: ${p}`);
  await page.close();
}
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
  if (files.length > 40) fail(`${files.length} screenshots (limit 40)`);
  if (bytes > 5 * 1024 * 1024) fail(`${(bytes / 1048576).toFixed(2)} MB of screenshots (limit 5 MB)`);
  console.log(`${files.length} screenshots, ${(bytes / 1048576).toFixed(2)} MB in docs/design/2.0-mock-shots/`);
}
await browser.close();
if (failures.length) { console.error(`FAIL (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log(`PASS: ${shots.length + checks.length} frames checked (no horizontal overflow at 320 px, status heights, labels, fixtures in sync).`);
