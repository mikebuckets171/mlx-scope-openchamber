import { ICON_PATH } from './parts.ts';
import type { Basis } from '../../../src/contract/capabilities.ts';
import type { AttrChip } from '../../present/history.ts';

// Owner: ui-history. DOM parts shared by the History and Captures views. Every value becomes a text node (never HTML);
// a render builds a fresh tree and `morph` patches it into the live one, so focus, open ⓘ and selects survive a poll.

type Attrs = Record<string, string | number | boolean | null | undefined>;
export type Child = Node | string | number | null | undefined | false | readonly Child[];
const SVG = 'http://www.w3.org/2000/svg';

const fill = (node: Element, attrs: Attrs, children: readonly Child[]): void => {
  for (const [name, value] of Object.entries(attrs)) if (value !== null && value !== undefined && value !== false) node.setAttribute(name, value === true ? '' : String(value));
  const add = (child: Child): void => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) (child as readonly Child[]).forEach(add);
    else node.appendChild(typeof child === 'object' ? child as Node : document.createTextNode(String(child)));
  };
  children.forEach(add);
};
export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); fill(node, attrs, children); return node;
};
export const svg = (tag: string, attrs: Attrs = {}, ...children: Child[]): SVGElement => {
  const node = document.createElementNS(SVG, tag) as SVGElement; fill(node, attrs, children); return node;
};
/** The DOM-rendered views use the same glyphs as the markup-rendered views. */
export const scopeIcon = (name: keyof typeof ICON_PATH): SVGElement => svg('svg',
  { class: 'scope-icon', viewBox: '0 0 24 24', fill: 'currentColor', stroke: 'none', 'aria-hidden': 'true', focusable: 'false' },
  svg('path', { d: ICON_PATH[name] }));
/** Common text and layout nodes keep History and Captures markup concise. */
export const span = (...children: Child[]): HTMLSpanElement => el('span', {}, ...children);
export const strong = (...children: Child[]): HTMLElement => el('strong', {}, ...children);
export const small = (...children: Child[]): HTMLElement => el('small', {}, ...children);
export const group = (...children: Child[]): HTMLDivElement => el('div', {}, ...children);
export const box = (className: string, ...children: Child[]): HTMLDivElement => el('div', { class: className }, ...children);

/** Patches `live` to match `next` in place: same-shaped nodes keep their identity (and focus); the rest are replaced. */
export const morph = (live: Element, next: Element): void => {
  const nodes = Array.from(next.childNodes);
  nodes.forEach((child, index) => {
    const current = live.childNodes[index];
    if (!current) { live.appendChild(child); return; }
    if (current.nodeType !== child.nodeType || current.nodeName !== child.nodeName) { live.replaceChild(child, current); return; }
    if (current.nodeType !== Node.ELEMENT_NODE) { if (current.nodeValue !== child.nodeValue) current.nodeValue = child.nodeValue; return; }
    const a = current as Element, b = child as Element;
    Array.from(a.attributes).forEach(({ name }) => { if (!b.hasAttribute(name)) a.removeAttribute(name); });
    Array.from(b.attributes).forEach(({ name, value }) => { if (a.getAttribute(name) !== value) a.setAttribute(name, value); });
    morph(a, b);
  });
  while (live.childNodes.length > nodes.length) live.lastChild!.remove();
};

/** ⓘ disclosures: a 24 px button whose explanation opens in flow below its row; open state is kept across renders. */
export class Tips {
  readonly open = new Set<string>();
  constructor(private readonly prefix: string) {}
  toggle(key: string): void { if (!this.open.delete(key)) this.open.add(key); }
  make(key: string, title: string, paras: readonly string[]): { btn: HTMLElement; pop: HTMLElement } {
    const id = `${this.prefix}-tip-${key}`, open = this.open.has(key);
    return {
      btn: el('button', { class: 'info', type: 'button', 'aria-expanded': String(open), 'aria-controls': id, 'aria-label': `About ${title}`, 'data-action': 'tip', 'data-arg': key }, scopeIcon('info')),
      pop: el('div', { class: 'pop', id, role: 'note', hidden: !open }, el('strong', {}, title), paras.map(p => el('p', {}, p))),
    };
  }
}

/** Attribution chips are labels, not status; a server-wide chip always carries its reason in its text. */
export const chip = (label: AttrChip): HTMLElement => el('span', { class: 'chip', 'data-attr': label.attr, 'data-outline': label.attr !== 'inferred', 'data-reason': label.reason }, label.text);
/** A value with its basis: anything but `reported` shows the label beside it (P3). */
export const val = (content: Child, basis: Basis, note: string | null): HTMLElement =>
  el('span', { class: 'val', 'data-basis': basis }, content, basis !== 'reported' && note ? el('small', { class: 'basis' }, note) : null);
export const section = (title: string, right: Child, body: Child, tip?: { btn: HTMLElement; pop: HTMLElement }, className = 'insight-section'): HTMLElement =>
  el('section', { class: className },
    el('div', { class: 'section-heading' }, el('div', { class: 'title-row' }, el('h2', {}, title), tip?.btn), right ? el('span', {}, right) : null),
    tip?.pop, body);
export const seg = (label: string, action: string, items: ReadonlyArray<{ label: string; arg: string; pressed: boolean }>): HTMLElement =>
  el('span', { class: 'seg', role: 'group', 'aria-label': label },
    items.map(item => el('button', { type: 'button', 'aria-pressed': String(item.pressed), 'data-action': action, 'data-arg': item.arg }, item.label)));
export const button = (label: Child, action: string, options: { className?: string; arg?: string; disabled?: boolean; focus?: string } = {}): HTMLButtonElement =>
  el('button', { class: options.className ?? 'btn', type: 'button', 'data-action': action, 'data-arg': options.arg, disabled: options.disabled, 'data-focus': options.focus ?? action }, label);

/** One delegated listener per event type, so rebuilt trees need no rebinding. */
export const delegate = (root: HTMLElement, handle: (action: string, arg: string, target: HTMLElement, event: Event) => void): (() => void) => {
  const listener = (event: Event): void => {
    const target = (event.target as Element | null)?.closest<HTMLElement>('[data-action]');
    if (!target || !root.contains(target) || event.type === 'click' && target.tagName === 'SELECT') return;
    if (event.type === 'change' && target.tagName !== 'SELECT') return;
    handle(target.dataset.action!, target.dataset.arg ?? '', target, event);
  };
  root.addEventListener('click', listener); root.addEventListener('change', listener);
  return () => { root.removeEventListener('click', listener); root.removeEventListener('change', listener); };
};
/** Focus by `data-focus` key after a render, for dialogs that open and close in flow. */
export const focusKey = (root: HTMLElement, key: string | null): void => { if (key) root.querySelector<HTMLElement>(`[data-focus="${key}"]`)?.focus({ preventScroll: true }); };
