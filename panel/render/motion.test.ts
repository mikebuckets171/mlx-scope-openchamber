import { afterEach, expect, test } from 'bun:test';
import { Motion } from './motion.ts';

const mediaDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
const motions: Motion[] = [];
afterEach(() => {
  for (const motion of motions.splice(0)) motion.dispose();
  if (mediaDescriptor) Object.defineProperty(globalThis, 'matchMedia', mediaDescriptor);
  else Reflect.deleteProperty(globalThis, 'matchMedia');
});

const harness = () => {
  const events: string[] = [], calls: { name: string; options: KeyframeAnimationOptions; cancelled: boolean }[] = [];
  const reduced = { matches: false, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: () => reduced });
  const node = (name: string, attributes: Record<string, string>, textContent = name, visible = true) => ({
    textContent, attributes, visible,
    hasAttribute(key: string) { return Object.hasOwn(this.attributes, key); },
    getAttribute(key: string) { return this.attributes[key] ?? null; },
    checkVisibility() { events.push(`read:${name}`); return this.visible; },
    animate(_frames: Keyframe[], options: KeyframeAnimationOptions) {
      events.push(`animate:${name}`);
      const call = { name, options, cancelled: false }; calls.push(call);
      return { finished: new Promise(() => {}), cancel() { call.cancelled = true; } };
    },
  });
  const nodes: ReturnType<typeof node>[] = [];
  const root = { querySelectorAll() { events.push('scan'); return nodes; } } as unknown as HTMLElement;
  const motion = new Motion(root); motions.push(motion);
  return { motion, nodes, node, events, calls, reduced };
};

test('motion reads every candidate before animating and scans once per render', () => {
  const { motion, nodes, node, events, calls } = harness();
  const phase = node('phase', { 'data-crossfade': '' }, 'Ready');
  nodes.push(node('mark', { 'data-heartbeat': '' }), node('first', { 'data-arrive': '' }), phase,
    node('hidden', { 'data-arrive': '' }, '', false), node('second', { 'data-arrive': '' }));
  motion.sync(true, 'sample/1');
  expect(events).toEqual(['scan', 'read:mark', 'read:first', 'read:hidden', 'read:second', 'animate:first', 'animate:second', 'animate:mark']);
  expect(calls.map(({ name, options }) => ({ name, ...options }))).toEqual([
    { name: 'first', duration: 120, delay: 0, easing: 'ease-out', fill: 'backwards' },
    { name: 'second', duration: 120, delay: 40, easing: 'ease-out', fill: 'backwards' },
    { name: 'mark', duration: 260, easing: 'cubic-bezier(.2,.7,.3,1)' },
  ]);
  events.length = 0;
  motion.sync(true, 'sample/1');
  expect(events).toEqual(['scan']);
  phase.textContent = 'Generating'; events.length = 0;
  motion.sync(true, 'sample/2');
  expect(events).toEqual(['scan', 'read:mark', 'read:phase', 'animate:phase', 'animate:mark']);
  expect(calls[3]!.options).toEqual({ duration: 120, easing: 'ease-out' });
});

test('a crossfade key follows the visible label without animating changed hidden basis text', () => {
  const { motion, nodes, node, calls } = harness();
  const source = node('source', { 'data-crossfade': 'Chat · est.' }, 'Chat · est. Estimated delivery over 3s.');
  nodes.push(source); motion.sync(true, null);
  source.textContent = 'Chat · est. Estimated delivery over 5s.';
  motion.sync(true, null);
  expect(calls).toEqual([]);
  source.attributes['data-crossfade'] = 'Last chat · avg.';
  source.textContent = 'Last chat · avg. Reported output divided by duration.';
  motion.sync(true, null);
  expect(calls.map(call => call.name)).toEqual(['source']);
});

test.each(['inactive', 'reduced'])('%s sync cancels current motion and never replays changes received while still', mode => {
  const { motion, nodes, node, calls, reduced, events } = harness();
  const phase = node('phase', { 'data-crossfade': '' }, 'Ready');
  nodes.push(node('mark', { 'data-heartbeat': '' }), node('first', { 'data-arrive': '' }), phase);
  motion.sync(true, 'sample/1');
  expect(calls).toHaveLength(2);
  nodes.push(node('new', { 'data-arrive': '' })); phase.textContent = 'Generating';
  reduced.matches = mode === 'reduced'; events.length = 0;
  motion.sync(mode !== 'inactive', 'sample/2');
  expect(calls.every(call => call.cancelled)).toBe(true);
  expect(events).toEqual(['scan']);
  reduced.matches = false;
  motion.sync(true, 'sample/2');
  expect(calls).toHaveLength(2);
  phase.textContent = 'Using tools';
  motion.sync(true, 'sample/3');
  expect(calls.slice(2).map(call => call.name)).toEqual(['phase', 'mark']);
});
