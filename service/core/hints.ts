import type { RuntimeKind as Runtime } from '../../src/contract/runtime.ts';

type Hint = (id: string, name: string) => boolean;
/**
 * Provider id and name hints, in precedence order. A leaf module: config.ts reads it while resolving connections,
 * and registry descriptors carry it, without an import cycle through the oMLX client.
 */
export const HINTS: ReadonlyArray<readonly [Runtime, Hint]> = [
  ['lmstudio', (id, name) => /bionic|lm[\s_-]*studio/.test(`${id} ${name}`.toLowerCase())],
  // splish is the owner's Splash fork (plan §4.1): its provider id or name selects Splash.
  ['splash', (id, name) => id.trim().toLowerCase() === 'splash' || /splash/i.test(name) || /splish/i.test(`${id} ${name}`)],
  ['vllm-mlx', (id, name) => /vllm[\s_-]*mlx/.test(`${id} ${name}`.toLowerCase())],
  ['omlx', (id, name) => /omlx/.test(`${id} ${name}`.toLowerCase())],
  ['mlx-lm', (id, name) => /mlx[\s_-]*lm/.test(`${id} ${name}`.toLowerCase())],
  // llama.cpp's server; the lookbehind keeps "ollama" out.
  ['llama-server', (id, name) => /(?<!o)llama[\s._-]*(?:cpp|server)/i.test(`${id} ${name}`)],
  ['ollama', (id, name) => /ollama/i.test(`${id} ${name}`)],
];
export const hintFor = (id: string, name: unknown): Runtime | null =>
  HINTS.find(([, hint]) => hint(id, typeof name === 'string' ? name : ''))?.[0] ?? null;
