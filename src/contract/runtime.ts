import { oneOf } from './guards.ts';

/** 1.x order first, so existing selections and menus keep their positions. */
export const RUNTIMES = ['omlx', 'lmstudio', 'mlx-lm', 'vllm-mlx', 'splash', 'llama-server', 'ollama'] as const;
export type RuntimeKind = typeof RUNTIMES[number];
/** Product names only; every other runtime string lives in panel/present/messages.ts. */
export const runtimeNames: Record<RuntimeKind, string> = {
  omlx: 'oMLX', lmstudio: 'LM Studio', 'mlx-lm': 'mlx-lm', 'vllm-mlx': 'vllm-mlx', splash: 'Splash (standalone)',
  'llama-server': 'llama-server', ollama: 'Ollama',
};
export const runtimeKind = oneOf(RUNTIMES);
