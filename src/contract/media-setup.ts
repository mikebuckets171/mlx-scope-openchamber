/** Managed setup is separate from observations: an installed helper is not necessarily loaded. */
export type MediaSetupState = 'ready' | 'available' | 'pending' | 'unsupported' | 'ambiguous' | 'offline' | 'error';
export interface MediaSetupSource {
  enabled?: boolean;
  id: string; label: string; state: MediaSetupState; message: string;
  canEnable: boolean; canDisable: boolean; managed: boolean;
  helperVersion: string | null; runtimeVersion: string | null;
  locations: Array<{ id: string; label: string }>;
}
export interface MediaSetupStatus { schemaVersion: 1; enabled?: boolean; sources: MediaSetupSource[] }
export type MediaSetupAction =
  | { action: 'enable' | 'disable'; sourceId: string; locationId?: string }
  | { action: 'configure'; sourceId?: string; label?: string; origin: string; installationPath?: string }
  | { action: 'set-enabled'; sourceId?: string; enabled: boolean };
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const identifier = (value: unknown): value is string => string(value, 120) && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value);
export function parseMediaSetup(value: unknown): MediaSetupStatus | null {
  const root = object(value);
  if (root?.schemaVersion !== 1 || root.enabled !== undefined && typeof root.enabled !== 'boolean' || !Array.isArray(root.sources) || root.sources.length > 8) return null;
  const sources: MediaSetupSource[] = [];
  for (const raw of root.sources) {
    const item = object(raw);
    if (!item || !identifier(item.id) || !string(item.label, 100) || !string(item.message, 500)
      || !['ready', 'available', 'pending', 'unsupported', 'ambiguous', 'offline', 'error'].includes(String(item.state))
      || ['canEnable', 'canDisable', 'managed'].some(key => typeof item[key] !== 'boolean')
      || ['helperVersion', 'runtimeVersion'].some(key => item[key] !== null && !string(item[key], 60))
      || !Array.isArray(item.locations) || item.locations.length > 8) return null;
    const locations: MediaSetupSource['locations'] = [];
    for (const rawLocation of item.locations) {
      const location = object(rawLocation);
      if (!location || !identifier(location.id) || !string(location.label, 100)) return null;
      locations.push({ id: location.id, label: location.label });
    }
    sources.push({ id: item.id, label: item.label, state: item.state as MediaSetupState, message: item.message, ...typeof item.enabled === 'boolean' ? { enabled: item.enabled } : {},
      canEnable: item.canEnable as boolean, canDisable: item.canDisable as boolean, managed: item.managed as boolean,
      helperVersion: item.helperVersion as string | null, runtimeVersion: item.runtimeVersion as string | null, locations });
  }
  return { schemaVersion: 1, ...root.enabled === undefined ? {} : { enabled: root.enabled as boolean }, sources };
}
export function parseMediaSetupAction(value: unknown): MediaSetupAction | null {
  const item = object(value);
  if (!item) return null;
  const keys = Object.keys(item);
  if (item.action === 'enable' || item.action === 'disable') {
    if (!identifier(item.sourceId) || item.locationId !== undefined && !identifier(item.locationId)
      || keys.some(key => !['action', 'sourceId', 'locationId'].includes(key))) return null;
    return { action: item.action, sourceId: item.sourceId, ...item.locationId === undefined ? {} : { locationId: item.locationId as string } };
  }
  if (item.action === 'configure') {
    if (!string(item.origin, 300) || item.sourceId !== undefined && !identifier(item.sourceId)
      || item.label !== undefined && !string(item.label, 100) || item.installationPath !== undefined && !string(item.installationPath, 1000)
      || keys.some(key => !['action', 'sourceId', 'label', 'origin', 'installationPath'].includes(key))) return null;
    return { action: 'configure', origin: item.origin, ...item.sourceId === undefined ? {} : { sourceId: item.sourceId as string },
      ...item.label === undefined ? {} : { label: item.label as string }, ...item.installationPath === undefined ? {} : { installationPath: item.installationPath as string } };
  }
  if (item.action === 'set-enabled' && (item.sourceId === undefined || identifier(item.sourceId)) && typeof item.enabled === 'boolean' && keys.every(key => ['action', 'sourceId', 'enabled'].includes(key)))
    return { action: 'set-enabled', ...item.sourceId === undefined ? {} : { sourceId: item.sourceId as string }, enabled: item.enabled };
  return null;
}
