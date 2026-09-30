// The G2 mock's checks (docs/design/shoot-2.0-mock.mjs `inspect`), run against the real 2.0 panel: no overflow, text
// ≥ 10 px and ≥ 4.5:1 against what is behind it (backgrounds composited up the tree), attribution chips that say
// inferred/armed or name their reason, a basis label on every non-reported value, no GPU alert, one callout per view,
// ⓘ targets ≥ 24 px with aria-expanded/aria-controls, no tooltip-only text, labelled charts and svgs, roving tabs, the
// glance's exact heights with nothing spilling, and interactive targets ≥ 24 px. Runs inside the panel frame.
export const inspect = (openAll: boolean): string[] => {
  const vw = innerWidth, problems: string[] = [];
  const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  if (openAll) for (const b of Array.from(document.querySelectorAll('button[aria-controls]:not([role="tab"])'))) {
    const target = document.getElementById(b.getAttribute('aria-controls')!);
    if (target && b.closest('.view, .ws')) { b.setAttribute('aria-expanded', 'true'); target.hidden = false; }
  }
  const clips = (el: Element) => { for (let a = el.parentElement; a; a = a.parentElement) if (getComputedStyle(a).overflowX !== 'visible') return a; return null; };
  if (document.documentElement.scrollWidth > vw) problems.push(`page scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= vw + .5 || el.closest('.monitor-menu-content')) continue;
    const c = clips(el);
    if (c && c.getBoundingClientRect().right <= vw + .5) continue;
    problems.push(`overflow: <${el.tagName.toLowerCase()} class="${(el as HTMLElement).className}"> right ${Math.round(r.right)} > ${vw}`);
  }
  type C = number[];
  const parse = (str: string): C | null => {
    let m = /^rgba?\(([^)]+)\)$/.exec(str);
    if (m) { const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0]! / 255, p[1]! / 255, p[2]! / 255, p[3] ?? 1]; }
    m = /^color\(srgb ([^)]+)\)$/.exec(str);
    if (m) { const p = m[1]!.split(/[\s/]+/).filter(Boolean).map(Number); return [p[0]!, p[1]!, p[2]!, p[3] ?? 1]; }
    return null;
  };
  const over = (top: C, base: C): C => [0, 1, 2].map(i => top[i]! * top[3]! + base[i]! * (1 - top[3]!));
  const lum = (c: C) => { const f = (v: number) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; return .2126 * f(c[0]!) + .7152 * f(c[1]!) + .0722 * f(c[2]!); };
  const ratio = (a: C, b: C) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const behind = (el: Element): C => {
    const chain: Element[] = []; for (let a: Element | null = el; a; a = a.parentElement) chain.unshift(a);
    let base: C = [1, 1, 1];
    for (const a of chain) {
      const cs = getComputedStyle(a), img = /(rgba?\([^)]*\)|color\(srgb[^)]*\))/.exec(cs.backgroundImage);
      if (img && !/repeating/.test(cs.backgroundImage)) { const c = parse(img[1]!); if (c) base = over(c, base); }
      const c = parse(cs.backgroundColor); if (c) base = over(c, base);
    }
    return base;
  };
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (!visible(el) || el.closest('.sr-only, svg') || (el as HTMLButtonElement).disabled || el.closest('[aria-hidden="true"]')) continue;
    const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    if (!own || /^[\s·•—–\-→›┊|:()+%]*$/.test(own)) continue;
    const cs = getComputedStyle(el), size = parseFloat(cs.fontSize);
    if (size < 10) problems.push(`text under 10 px (${size.toFixed(2)}): "${own.slice(0, 30)}"`);
    let alpha = 1; for (let a: Element | null = el; a; a = a.parentElement) alpha *= Number(getComputedStyle(a).opacity);
    const fg = parse(cs.color); if (!fg) continue;
    const bg = behind(el), text = over([fg[0]!, fg[1]!, fg[2]!, fg[3]! * alpha], bg), cr = ratio(text, bg);
    if (cr < 4.5 && !(size >= 18.66 || (size >= 14 && Number(cs.fontWeight) >= 700))) problems.push(`contrast ${cr.toFixed(2)}:1 for "${own.slice(0, 30)}" (${cs.color})`);
  }
  // Controls a pointer can hit: at least 24 × 24 px (WCAG 2.2 target size, minimum), unless inline in a sentence.
  for (const b of Array.from(document.querySelectorAll('button, summary, select, [role="tab"]'))) {
    if (!visible(b) || b.closest('.monitor-menu-content, .share-menu')) continue;
    const r = b.getBoundingClientRect(), inline = getComputedStyle(b).display === 'inline' || b.classList.contains('link-btn') && b.closest('p, span');
    if (!inline && (r.width < 24 || r.height < 24)) problems.push(`target ${Math.round(r.width)}×${Math.round(r.height)} px: "${b.textContent?.trim().slice(0, 30) || b.getAttribute('aria-label')}"`);
  }
  if (openAll) return problems;
  const text = document.body.innerText;
  if (/vram/i.test(text)) problems.push('says VRAM');
  for (const chip of Array.from(document.querySelectorAll<HTMLElement>('.chip[data-attr]'))) {
    if (!visible(chip)) continue;
    const t = chip.textContent!.trim(), desc = chip.getAttribute('aria-describedby'), target = desc ? document.getElementById(desc) : null;
    const describedOk = t === 'Server-wide' && target && target.textContent!.includes(chip.dataset.reason ?? '\u0000') && visible(target);
    if (!/^(This chat · inferred|Next reply · armed|Server-wide · .+)$/.test(t) && !describedOk) problems.push(`attribution chip "${t}" (server-wide needs its reason)`);
  }
  if (/This chat(?! · inferred| uses|’s| runs| was| has|, then)/.test(text)) problems.push('"This chat" without "inferred"');
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-basis]:not([data-basis="reported"])'))) {
    if (!visible(el) || el.classList.contains('chip')) continue;
    const label = el.querySelector('.basis') ?? (el.nextElementSibling?.classList.contains('basis') ? el.nextElementSibling : null);
    if (!label?.textContent?.trim()) problems.push(`value without basis label: "${el.textContent!.trim().slice(0, 40)}"`);
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('.metrics > div > strong, .ts-rows dd, .reply-values > span:not(.chip), .prefill-remaining')))
    if (!el.dataset.basis) problems.push(`value without a declared basis: "${el.textContent!.trim().slice(0, 30)}"`);
  for (const a of Array.from(document.querySelectorAll('.connection-diagnosis, .ws-alert'))) if (/GPU/.test(a.textContent!)) problems.push(`GPU alert: "${a.textContent!.trim().slice(0, 40)}"`);
  for (const v of Array.from(document.querySelectorAll('.view, .ws'))) {
    if (!visible(v)) continue;
    const top = Array.from(v.children).filter(c => c.classList.contains('connection-diagnosis') && visible(c));
    if (top.length > 1) problems.push(`${top.length} callouts stacked in one view`);
  }
  for (const b of Array.from(document.querySelectorAll('.info'))) {
    const r = b.getBoundingClientRect();
    if (visible(b) && (r.width < 24 || r.height < 24)) problems.push(`ⓘ target ${r.width}×${r.height} px`);
    if (!b.hasAttribute('aria-expanded') || !document.getElementById(b.getAttribute('aria-controls')!)) problems.push('ⓘ without aria-expanded/aria-controls target');
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[title]'))) if (el.closest('#scope')) problems.push(`tooltip-only text on <${el.tagName.toLowerCase()}>: "${el.title.slice(0, 30)}"`);
  for (const c of Array.from(document.querySelectorAll('.plot, .ws-spark'))) if (c.getAttribute('role') !== 'img' || !c.getAttribute('aria-label')) problems.push(`chart without role="img" and a summary: ${c.className}`);
  for (const svg of Array.from(document.querySelectorAll('svg'))) if (!svg.closest('[role="img"][aria-label], button, summary, .brand') && svg.getAttribute('aria-hidden') !== 'true') problems.push('unlabelled svg');
  for (const tab of Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'))) {
    const p = document.getElementById(tab.getAttribute('aria-controls')!);
    if (!p || p.getAttribute('role') !== 'tabpanel' || p.getAttribute('aria-labelledby') !== tab.id) problems.push(`tab ${tab.id} without its panel`);
    if (tab.tabIndex !== (tab.getAttribute('aria-selected') === 'true' ? 0 : -1)) problems.push(`tab ${tab.id} breaks roving tabindex`);
  }
  for (const ws of Array.from(document.querySelectorAll<HTMLElement>('.ws'))) {
    const want = Number(ws.style.height.replace('px', ''));
    if (ws.clientHeight !== want) problems.push(`status ${ws.dataset.mode}: height ${ws.clientHeight} ≠ ${want}`);
    if (ws.scrollHeight > ws.clientHeight) problems.push(`status ${ws.dataset.mode}: content ${ws.scrollHeight} px overflows ${ws.clientHeight} px`);
    if (want > 200) problems.push(`status ${ws.dataset.mode}: taller than 200 px`);
    for (const line of Array.from(ws.querySelectorAll('.ws-line, .ts-head'))) if (line.scrollWidth > line.clientWidth + 1) problems.push(`status ${ws.dataset.mode}: a line overflows (${line.scrollWidth} > ${line.clientWidth})`);
  }
  const compact = document.querySelector<HTMLElement>('.scope[data-compact="true"]');
  if (compact && compact.scrollHeight > 160) problems.push(`compact rail ${compact.scrollHeight} px tall (limit 160)`);
  return problems;
};
