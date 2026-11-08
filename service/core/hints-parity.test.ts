import { expect, it } from 'bun:test';
import { namesSplash } from '../../bridge/opencode/providers.js';
import { hintFor } from './hints.ts';

// The chat-speed helper decides "is this provider Splash?" with its own copy of the service's rule, because it ships
// without the service. Every id and name below must get the same answer from both.
const IDS = ['splash', 'Splash ', 'SPLASH', 'splish', 'my-splish-fork', 'local', 'llama-swap', 'lmstudio', 'bionic', 'omlx', 'mlx-lm', 'vllm-mlx',
  'ollama', 'llama-cpp', 'openai', 'anthropic', 'splash-bionic', ''];
const NAMES = ['Splash', 'splash', 'Splish', 'LM Studio', 'Splash via Bionic', 'Splash via llama-swap', 'oMLX', 'Ollama', 'OpenAI', 'My local model', ''];

it('the helper and the service call exactly the same providers Splash', () => {
  let splash = 0;
  for (const id of IDS) for (const name of NAMES) {
    const expected = hintFor(id, name) === 'splash';
    expect(namesSplash(id, name)).toBe(expected);
    if (expected) splash++;
  }
  expect(splash).toBeGreaterThan(20);
});
