import type { Runtime } from '../../src/runtime.ts';

type Hint = (id: string, name: string) => boolean;
/**
 * Provider id and name hints, in precedence order. A leaf module: config.ts reads it while resolving connections,
 * and registry descriptors carry it, without an import cycle through the oMLX client.
 */
export const HINTS: ReadonlyArray<readonly [Runtime, Hint]> = [
  ['lmstudio', (id, name) => /bionic|lm[\s_-]*studio/.test(`${id} ${name}`.toLowerCase())],
  ['splash', (id, name) => id.trim().toLowerCase() === 'splash' || /splash/i.test(name)],
  ['vllm-mlx', (id, name) => /vllm[\s_-]*mlx/.test(`${id} ${name}`.toLowerCase())],
  ['omlx', (id, name) => /omlx/.test(`${id} ${name}`.toLowerCase())],
  ['mlx-lm', (id, name) => /mlx[\s_-]*lm/.test(`${id} ${name}`.toLowerCase())],
];
export const hintFor = (id: string, name: unknown): Runtime | null =>
  HINTS.find(([, hint]) => hint(id, typeof name === 'string' ? name : ''))?.[0] ?? null;
