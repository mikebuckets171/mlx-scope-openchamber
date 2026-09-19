import { expect, it } from 'bun:test';
import { ChartInspector } from './chart-inspector.ts';

// Attribute-only view double; full pointer/keyboard behavior is also checked in browsers.
class View extends EventTarget {
  readonly attributes = new Map<string, string>();
  textContent = '';
  tabIndex = -1;
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  toggleAttribute(name: string, force: boolean): void {
    if (force) this.attributes.set(name, ''); else this.attributes.delete(name);
  }
}

it('keeps a selected reading until it expires, then clears rather than moving it to another reading', () => {
  const line = new View(), dot = new View(), output = new View();
  const plot = Object.assign(new View(), {querySelector: (selector: string) => selector === '#inspect-line' ? line : dot});
  const inspector = new ChartInspector(plot as unknown as HTMLElement, output as unknown as HTMLElement);
  const first = {at: 1_000, rate: 12, phase: 'decode' as const, segment: 1};
  const later = {at: 80_000, rate: 24, phase: 'decode' as const, segment: 1};
  inspector.update([first], 1_000, 50);
  plot.dispatchEvent(new Event('focus'));
  expect(output.textContent).toContain('12.0 tok/s');
  inspector.update([first, later], 80_000, 50);
  expect(output.textContent).toContain('12.0 tok/s');
  inspector.update([later], 91_001, 50);
  expect(output.textContent).toBe('Point to inspect · arrow keys when focused');
  expect(line.attributes.has('hidden')).toBe(true);
  expect(dot.attributes.has('hidden')).toBe(true);
  inspector.dispose();
});
