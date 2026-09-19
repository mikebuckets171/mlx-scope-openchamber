export const RUNTIMES = ['omlx', 'lmstudio', 'mlx-lm', 'vllm-mlx'] as const;
export type Runtime = typeof RUNTIMES[number];
export const runtimeNames: Record<Runtime, string> = {
  omlx: 'oMLX', lmstudio: 'LM Studio', 'mlx-lm': 'mlx-lm', 'vllm-mlx': 'vllm-mlx',
};
export type RuntimeSelection = { provider: string; runtime: Runtime | null };
export type ConnectionChoice = { id: string; label: string; runtime: Runtime | null };
export type ConnectionDiagnostic = 'ready' | 'missing' | 'invalid' | 'unreadable' | 'authentication' | 'offline' | 'unsupported';
export type ConnectionInfo = {
  selected: string | null;
  label: string | null;
  runtime: Runtime | null;
  generation?: string | null;
  choices: ConnectionChoice[];
  diagnostic: ConnectionDiagnostic;
  coverage: 'requests' | 'inventory' | 'server' | null;
};
export type CatalogModel = {
  name: string;
  loaded: boolean | null;
  format: 'mlx' | 'gguf' | null;
  contextWindow: number | null;
};
export const runtimeValue = (value: unknown): Runtime | null => RUNTIMES.includes(value as Runtime) ? value as Runtime : null;
const obj = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const label = (value: unknown, max = 120): string | null => typeof value === 'string' && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : null;
export const parseConnection = (value: unknown): ConnectionInfo | null => {
  const item = obj(value);
  if (!item) return null;
  const diagnostics: ConnectionDiagnostic[] = ['ready', 'missing', 'invalid', 'unreadable', 'authentication', 'offline', 'unsupported'];
  return {
    selected: label(item.selected), label: label(item.label), runtime: runtimeValue(item.runtime),
    generation: typeof item.generation === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.generation) ? item.generation : null,
    choices: (Array.isArray(item.choices) ? item.choices : []).slice(0, 8).flatMap(raw => {
      const choice = obj(raw), id = label(choice?.id), name = label(choice?.label);
      return id && name ? [{ id, label: name, runtime: runtimeValue(choice?.runtime) }] : [];
    }),
    diagnostic: diagnostics.includes(item.diagnostic as ConnectionDiagnostic) ? item.diagnostic as ConnectionDiagnostic : 'unsupported',
    coverage: ['requests', 'inventory', 'server'].includes(String(item.coverage)) ? item.coverage as ConnectionInfo['coverage'] : null,
  };
};
export const parseCatalog = (value: unknown): CatalogModel[] => (Array.isArray(value) ? value : []).slice(0, 12).flatMap(raw => {
  const item = obj(raw), name = label(item?.name, 160);
  if (!name) return [];
  return [{ name, loaded: typeof item?.loaded === 'boolean' ? item.loaded : null,
    format: item?.format === 'mlx' || item?.format === 'gguf' ? item.format : null,
    contextWindow: typeof item?.contextWindow === 'number' && Number.isSafeInteger(item.contextWindow) && item.contextWindow > 0 ? item.contextWindow : null }];
});
