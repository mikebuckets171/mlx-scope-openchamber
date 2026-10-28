import type { ConnectionV2 } from '../../src/contract/snapshot.ts';

// Friendly labels belong only in presentation. Runtime IDs, attribution keys and stored history keep their identity.
export type ModelNames = ConnectionV2['modelNames'];

const variant = (id: string): string => id.replace(/:[^/:]+$/, '');

/**
 * The name the provider's OpenCode entry gives a model, as its model picker shows it. A runtime may report the ID with a
 * `:variant` suffix (a GGUF quantization) or OpenCode's `provider/` prefix; anything still unmatched shows as reported.
 */
export const modelDisplayName = (model: string, names: ModelNames | undefined): string => {
  if (!names?.length) return model;
  const named = (id: string): string | undefined => names.find(entry => entry.model === id)?.name;
  const rest = model.includes('/') ? model.slice(model.indexOf('/') + 1) : null;
  return named(model) ?? named(variant(model)) ?? (rest === null ? undefined : named(rest) ?? named(variant(rest))) ?? model;
};
