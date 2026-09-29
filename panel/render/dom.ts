/** Patch-only access to the static shell: polls change text, attributes and geometry, never controls or structure. */
export class Dom {
  private readonly nodes = new Map<string, HTMLElement>();
  constructor(root: ParentNode) { root.querySelectorAll<HTMLElement>('[id]').forEach(node => this.nodes.set(node.id, node)); }
  node(id: string): HTMLElement { return this.nodes.get(id)!; }
  /** A reading's text. A placeholder dash is styled as quiet, never as a reading. */
  text(id: string, value: string): void {
    const target = this.node(id);
    if (target.textContent !== value) target.textContent = value;
    target.toggleAttribute('data-empty', value === '—');
  }
  /** Plain text for labels and notes that are never a reading. */
  put(id: string, value: string): void { const target = this.node(id); if (target.textContent !== value) target.textContent = value; }
  hidden(id: string, value: boolean): void { this.node(id).hidden = value; }
  meter(id: string, value: number | null): void { this.node(id).style.width = `${value === null ? 0 : Math.min(100, Math.max(0, value))}%`; }
}

/** Keep one child per value, reusing existing children; `make` builds a missing one from static markup only. */
export const syncChildren = <T>(list: HTMLElement, values: readonly T[], make: () => HTMLElement, fill: (row: HTMLElement, value: T) => void): void => {
  while (list.children.length > values.length) list.lastElementChild!.remove();
  values.forEach((value, index) => {
    let row = list.children[index] as HTMLElement | undefined;
    if (!row) { row = make(); list.append(row); }
    fill(row, value);
  });
};
export const put = (element: Element, text: string): void => { if (element.textContent !== text) element.textContent = text; };
