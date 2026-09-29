import { expect, test } from 'bun:test';
import { Visibility } from './visibility.ts';

// A page and IntersectionObserver double: the observer reports what a host frame would.
const setup = (size: { innerWidth: number; innerHeight: number }, observer = true) => {
  const listeners = new Map<string, () => void>(), observed: unknown[] = [];
  let report: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null, disconnected = false, changes = 0;
  const page = { hidden: false, documentElement: {} as HTMLElement,
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type) };
  const visibility = new Visibility(page as unknown as Document, size, () => { changes += 1; }, observer ? callback => {
    report = callback;
    return { observe: target => observed.push(target), disconnect: () => { disconnected = true; } };
  } : null);
  return { page, visibility, observed, listeners, changes: () => changes, disconnected: () => disconnected,
    intersect: (value: boolean) => report!([{ isIntersecting: value }]) };
};

test('a frame mounted at 0×0 (a hidden rail tab) is not visible until the observer sees it', () => {
  const frame = setup({ innerWidth: 0, innerHeight: 0 });
  expect(frame.observed).toEqual([frame.page.documentElement]);
  expect(frame.visibility.visible).toBe(false);
  frame.intersect(false); expect(frame.changes()).toBe(0);
  frame.intersect(true); expect(frame.visibility.visible).toBe(true); expect(frame.changes()).toBe(1);
  frame.intersect(true); expect(frame.changes()).toBe(1);
  frame.intersect(false); expect(frame.visibility.visible).toBe(false); expect(frame.changes()).toBe(2);
});

test('a visible frame polls at once; document.hidden still hides it; every visibility event re-syncs', () => {
  const frame = setup({ innerWidth: 320, innerHeight: 900 });
  expect(frame.visibility.visible).toBe(true);
  frame.intersect(true); expect(frame.changes()).toBe(0);
  frame.page.hidden = true;
  expect(frame.visibility.visible).toBe(false);
  frame.listeners.get('visibilitychange')!(); frame.listeners.get('visibilitychange')!();
  expect(frame.changes()).toBe(2);
  frame.visibility.dispose();
  expect(frame.disconnected()).toBe(true); expect(frame.listeners.has('visibilitychange')).toBe(false);
});

test('without IntersectionObserver the synchronous size estimate stands', () => {
  expect(setup({ innerWidth: 320, innerHeight: 900 }, false).visibility.visible).toBe(true);
  expect(setup({ innerWidth: 0, innerHeight: 0 }, false).visibility.visible).toBe(false);
});
