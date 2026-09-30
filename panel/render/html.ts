// Markup for the 2.0 views: every value is escaped unless it is already markup (`Raw`), and `morph` patches the live DOM
// toward new markup in place, so a poll never rebuilds a focused control, an open disclosure or a running transition.

export class Raw { constructor(readonly markup: string) {} }
export type Part = Raw | string | number | null | undefined | false | readonly Part[];
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value: string | number): string => String(value).replace(/[&<>"']/g, char => ESCAPES[char]!);
export const emit = (value: Part): string =>
  value == null || value === false ? '' : value instanceof Raw ? value.markup : Array.isArray(value) ? value.map(emit).join('') : esc(value as string | number);
/** Tagged template: `html\`<b>${text}</b>\`` escapes `text`; nested `html` and arrays of it pass through. */
export const html = (parts: TemplateStringsArray, ...values: Part[]): Raw =>
  new Raw(parts.reduce((out, part, index) => out + part + (index < values.length ? emit(values[index]!) : ''), ''));
export const raw = (markup: string): Raw => new Raw(markup);
/** An attribute that is present or absent, e.g. `${flag('hidden', !open)}`. */
export const flag = (name: string, on: boolean): Raw => new Raw(on ? ` ${name}` : '');

const key = (node: Node): string | null => node instanceof Element ? node.getAttribute('data-key') ?? node.id ?? null : null;
const same = (a: Node, b: Node): boolean => a.nodeType === b.nodeType && a.nodeName === b.nodeName && key(a) === key(b);
const patchAttributes = (from: Element, to: Element): void => {
  for (const { name } of Array.from(from.attributes)) if (!to.hasAttribute(name)) from.removeAttribute(name);
  for (const { name, value } of Array.from(to.attributes)) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
};
const patch = (from: Node, to: Node): void => {
  if (from.nodeType === Node.TEXT_NODE || from.nodeType === Node.COMMENT_NODE) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }
  if (from instanceof Element && to instanceof Element) {
    patchAttributes(from, to);
    // A <select> keeps what the user picked; a `data-mount` host belongs to a view mounted into it.
    if (from.localName === 'select' || from.hasAttribute('data-mount')) return;
  }
  patchChildren(from, to);
};
const patchChildren = (from: Node, to: Node): void => {
  let current = from.firstChild, next = to.firstChild;
  while (next) {
    const following = next.nextSibling;
    if (!current) from.appendChild(next);
    else if (same(current, next)) { patch(current, next); current = current.nextSibling; }
    else { const after = current.nextSibling; from.replaceChild(next, current); current = after; }
    next = following;
  }
  while (current) { const after = current.nextSibling; from.removeChild(current); current = after; }
};
/** Patch `target`'s children toward `markup`. Unchanged markup is skipped entirely. */
export const morph = (target: Element, markup: Raw | string): void => {
  const text = markup instanceof Raw ? markup.markup : markup;
  if ((target as Element & { __markup?: string }).__markup === text) return;
  (target as Element & { __markup?: string }).__markup = text;
  const template = target.ownerDocument.createElement('template');
  template.innerHTML = text;
  patchChildren(target, template.content);
};
