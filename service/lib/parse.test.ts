import { expect, test } from 'bun:test';
import { count, modelLabel, nonneg, obj, positive } from './parse.ts';

// The adapter-local guards these replace, as shipped in 1.6.1 (service/splash.ts, service/mlx-lm.ts, service/lmstudio.ts).
const legacy = {
  object: (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null,
  number: (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null,
  count: (value: unknown) => { const n = legacy.number(value); return n !== null && Number.isSafeInteger(n) ? n : null; },
  contextLength: (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null,
  modelName: (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!clean) return null;
    const label = /^(?:[\\/]|\.{1,2}[\\/]|~[\\/]|file:|[A-Za-z]:[\\/])/.test(clean) ? clean.split(/[\\/]/).filter(Boolean).at(-1) : clean;
    return label?.slice(0, 160) || null;
  },
};

test('the shared guards behave exactly like the adapter guards they replace', () => {
  const values: unknown[] = [null, undefined, true, 'text', '12', [], [1], {}, { a: 1 }, 0, -0, 1, -1, 1.5, 2 ** 53, 2 ** 53 - 1, NaN, Infinity, -Infinity, 8192];
  for (const value of values) {
    expect(obj(value), String(value)).toBe(legacy.object(value) as never);
    expect(nonneg(value), String(value)).toBe(legacy.number(value));
    expect(count(value), String(value)).toBe(legacy.count(value));
    expect(positive(value), String(value)).toBe(legacy.contextLength(value));
  }
  const names: unknown[] = [null, 7, '', '   ', '\u0000', 'model', ' model\u0007 ', '/models/org/name', '/models/org/name/', './local/name', '../up/name',
    '~/cache/name', 'C:\\models\\name', 'file:///models/name', 'org/name', 'https://example.invalid/name', '/', `${'x'.repeat(170)}`, `/a/${'y'.repeat(170)}`];
  for (const name of names) expect(modelLabel(name), String(name)).toBe(legacy.modelName(name));
});
