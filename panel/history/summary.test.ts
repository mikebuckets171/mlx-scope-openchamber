import { describe, expect, test } from 'bun:test';
import { reply } from '../testing/rows.ts';
import { buildBaselines, type Baseline } from './baselines.ts';
import { baselineSummary, modelAlias, SUMMARY_MAX_CHARS } from './summary.ts';

const NOW = 1_790_690_700_000, H = 3_600_000;
// Canary model names (class B): they may be in the ledger dictionary but never in the summary.
const MODELS = ['canary-model-Qwen-27B-4bit', 'canary-model-Splash-35B'];

describe('Copy baseline summary (decision 11)', () => {
  test('aliases models "Model A/B", keeps n, and never names a model', () => {
    const rows = [...Array.from({ length: 12 }, (_, i) => reply({ at: NOW - H - i * 60_000, decodeTps: 24 + i % 3, prefillTps: 600, ttftMs: 450 })),
      ...Array.from({ length: 6 }, (_, i) => reply({ at: NOW - H - i * 60_000, rt: 'splash', modelRef: 1, decodeTps: 40, energyJ: 1500 }))];
    const text = baselineSummary(buildBaselines(rows, NOW), MODELS, '2.0.0', NOW);
    expect(text).toContain('MLX Scope 2.0.0 — usual speeds (baseline summary)');
    expect(text).toContain('Model A · oMLX · 32–64K context · decode: p50 25.0 tok/s · p90 26.0 tok/s · n 12');
    expect(text).toContain('Model A · oMLX · under 8K uncached input · TTFT: p50 0.45 s · p90 0.45 s · n 12');
    expect(text).toContain('Model B · Splash (standalone) · 32–64K context · tok/J (chip estimate): p50 0.67 · n 6');
    for (const name of MODELS) expect(text).not.toContain(name);
    expect(text).not.toMatch(/canary|\/Users\/|session/i);
  });
  test('a key below 5 replies says so, with its n', () => {
    const text = baselineSummary(buildBaselines([reply({ at: NOW - H, decodeTps: 20 })], NOW), MODELS, '2.0.0', NOW);
    expect(text).toContain('decode: not enough replies yet (n 1; p50 needs 5)');
  });
  test('an empty ledger still copies an honest line', () => {
    expect(baselineSummary(new Map(), [], '2.0.0', NOW)).toContain('No usual speeds yet');
  });
  test('stays under 32,000 characters with whole lines and says how many were left out', () => {
    const baselines = new Map<string, Baseline>();
    for (let ref = 0; ref < 2_000; ref += 1) for (const bucket of [0, 1, 2]) baselines.set(`decodeTps|omlx|${ref}|${bucket}`, { p50: 25, p90: 27, n: 50 });
    const text = baselineSummary(baselines, MODELS, '2.0.0', NOW);
    expect(text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(text).toMatch(/… \d+ more rows left out to stay under 32,000 characters\.$/);
    expect(text.split('\n').filter(line => line.startsWith('Model ')).every(line => line.endsWith('n 50'))).toBe(true);
  });
  test('the sanitizer still removes a model name that reached the text', () => {
    // A model literally named like a runtime is the worst case: redaction wins over readability.
    expect(baselineSummary(new Map([['decodeTps|omlx|0|2', { p50: 25, p90: null, n: 5 }]]), ['oMLX'], '2.0.0', NOW)).not.toContain('oMLX');
  });
  test('aliases run A…Z, then AA', () => {
    expect([0, 1, 25, 26, 27, 701].map(modelAlias)).toEqual(['Model A', 'Model B', 'Model Z', 'Model AA', 'Model AB', 'Model ZZ']);
  });
});
