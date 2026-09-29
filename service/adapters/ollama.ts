import type { ResidencyV2 } from '../../src/contract/snapshot.ts';
import type { DescriptorV2 } from '../core/adapter-v2.ts';

// Owner: ad-llama-ollama. /api/version (60 s) + /api/ps (5 s); residency only, no completions. size_vram is
// "GPU-resident (Ollama-reported)", never VRAM; expires_at → unloadsAt.

export const parseOllamaVersion = (body: unknown): string | null => { void body; return null; };
export const parseOllamaPs = (body: unknown): ResidencyV2[] => { void body; return []; };

export const ollamaDescriptor: DescriptorV2 = {
  id: 'ollama', hints: () => false, detect: [], cadence: () => 2_000, capabilities: [], identityEveryMs: 60_000,
  create: () => { throw new Error('ollama adapter: not implemented (ad-llama-ollama)'); },
};
