import { expect, test } from 'bun:test';
import { ago, clock, delta, dur } from './format.ts';
import { delta as relativeDelta } from './history.ts';

test('shared time and change formats keep the boundary and ratio meanings', () => {
  expect([999, 1000, 9999, 10000, 59_999, 60_000, 65_000, 3_600_000].map(dur))
    .toEqual(['1.00 s', '1.0 s', '10.0 s', '10 s', '60 s', '1 min', '1 m 05 s', '1 h 0 m']);
  expect([0.977, 1.019, 1.002, 0.75].map(relativeDelta)).toEqual(['−2%', '+2%', '±0%', '−25%']);
  expect([-0.023, 0.019, 0.002, -0.25].map(delta)).toEqual(['−2%', '+2%', '±0%', '−25%']);
  expect(ago(1000, 0)).toBe('just now');
  const today = new Date(2026, 9, 11, 1), yesterday = new Date(2026, 9, 10, 23);
  expect(clock(today.getTime(), today.getTime())).toBe(new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(today));
  expect(clock(yesterday.getTime(), today.getTime())).toBe(new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(yesterday));
});

test('History keeps host-locale grouping while the page keeps its established en-US grouping', () => {
  // Import in an isolated realm with a different host locale; changing the real host setting is unnecessary.
  const run = Bun.spawnSync({ cmd: [process.execPath, '-e', `
    const Native = Intl.NumberFormat;
    Intl.NumberFormat = class extends Native { constructor(locale, options) { super(locale ?? 'de-DE', options); } };
    const h = await import('./panel/present/history.ts');
    const f = await import('./panel/present/format.ts');
    console.log(JSON.stringify({ history: [h.int(1234), h.int(-1.5), h.kt(1234), h.kt(12300), h.tps(1234)], page: [f.int(1234), f.kt(1234), f.tps(1234)] }));
  `], cwd: `${import.meta.dir}/../..` });
  expect(run.exitCode).toBe(0);
  expect(JSON.parse(run.stdout.toString())).toEqual({ history: ['1.234', '-1', '1.234', '12.3K', '1.234'], page: ['1,234', '1,234', '1,234'] });
});
