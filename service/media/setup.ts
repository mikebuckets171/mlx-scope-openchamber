import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { MediaSetupAction, MediaSetupSource, MediaSetupStatus } from '../../src/contract/media-setup.ts';
import { parseMediaSetupAction } from '../../src/contract/media-setup.ts';
import { requestText } from '../lib/http-text.ts';
import type { FetchImplementation } from '../http.ts';
import { localOrigin, mediaConfigPath, type MediaSourceConfig } from './discovery.ts';
import { mediaId, type MediaSnapshotV1, type MediaSourceV1 } from '../../src/contract/media.ts';
import { label as safeLabel } from '../../src/contract/guards.ts';

export const MEDIA_HELPER_FILES = ['__init__.py', 'snapshot.py'] as const;
export const MEDIA_HELPER_VERSION = '1.0.0';
const OWNER = '.mlx-scope-owner.json', MAX_FILE = 128_000;
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
export class MediaSetupError extends Error {}
const fail = (message: string): never => { throw new MediaSetupError(message); };
export interface MediaSetupOptions {
  home: string; bundleDirectory: string; sources(): Promise<MediaSourceConfig[]>; invalidate(enabled?: boolean): void;
  snapshot?: () => Promise<MediaSnapshotV1>;
  fetchImpl?: FetchImplementation; beforeCommit?: () => Promise<void>;
}
type Installation = { root: string; directory: string; id: string; version: string | null; managed: boolean; files: Map<string, string>; exists: boolean };

/** Refuse links and special files instead of letting setup write through an unexpected path. */
async function parents(path: string): Promise<void> {
  if (!isAbsolute(path)) fail('Choose an absolute ComfyUI folder path.');
  for (let p = path; p !== dirname(p); p = dirname(p)) {
    try { const info = await lstat(p); if (!info.isDirectory() || info.isSymbolicLink()) fail('This installation uses a linked folder. Choose its original folder.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
async function file(path: string, max = MAX_FILE): Promise<string | null> {
  await parents(dirname(path));
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > max || process.getuid && info.uid !== process.getuid()) fail('A setup file is not a safe, owned regular file.');
    const bytes = Buffer.alloc(info.size + 1), read = await handle.read(bytes, 0, bytes.length, 0), after = await handle.stat();
    if (read.bytesRead !== info.size || after.mtimeMs !== info.mtimeMs || after.size !== info.size) fail('An installation file changed. Try again.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}
function json(text: string): RecordValue {
  try { const value = object(JSON.parse(text)); if (value) return value; } catch {}
  return fail('The media connection configuration is invalid. Its contents were preserved.');
}
async function installation(root: string): Promise<Installation | null> {
  await parents(root);
  if (!await file(join(root, 'server.py'), 1_000_000) || !await file(join(root, 'comfy_execution', 'progress.py'), 500_000)) return null;
  const version = /__version__\s*=\s*["']([^"']+)["']/.exec(await file(join(root, 'comfyui_version.py')) ?? '')?.[1] ?? null;
  const directory = join(root, 'custom_nodes', 'mlx_scope'), files = new Map<string, string>();
  let exists = false;
  try {
    await parents(directory);
    const entries = await readdir(directory, { withFileTypes: true }); exists = true;
    if (entries.length > 8) fail('The existing media helper contains additional files. They were preserved.');
    for (const entry of entries) {
      if (entry.name === '__pycache__' && entry.isDirectory()) continue;
      if (!entry.isFile() || ![...MEDIA_HELPER_FILES, 'scope-token', OWNER].includes(entry.name)) fail('Another installation occupies the media helper folder. It was preserved.');
      const text = await file(join(directory, entry.name)); if (text === null) fail('The helper changed while it was inspected.'); files.set(entry.name, text!);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const marker = files.has(OWNER) ? json(files.get(OWNER)!) : null, hashes = object(marker?.files);
  const managed = !!marker && marker.owner === 'mlx-scope-comfyui' && marker.schemaVersion === 1 && !!hashes;
  if (exists && (!managed || [...files].some(([name, text]) => name !== OWNER && hashes?.[name] !== hash(text))))
    fail('The existing media helper has local changes. Update it manually or choose a different installation.');
  return { root, directory, id: hash(root).slice(0, 16), version, managed, files, exists };
}
async function unchanged(info: Installation): Promise<void> {
  const latest = await installation(info.root);
  if (!latest || latest.exists !== info.exists || latest.files.size !== info.files.size
    || [...info.files].some(([name, value]) => latest.files.get(name) !== value)) fail('The media helper changed during setup. Your changes were preserved.');
}

export function createMediaSetup(options: MediaSetupOptions) {
  let lock: Promise<unknown> = Promise.resolve();
  const fetchImpl = options.fetchImpl ?? fetch;
  const locations = async (source: MediaSourceConfig): Promise<Installation[]> => {
    const roots = source.installationPath ? [source.installationPath] : [join(options.home, 'ComfyUI'), join(options.home, 'Applications', 'ComfyUI')];
    const found: Installation[] = [];
    for (const root of [...new Set(roots)].slice(0, 8)) { const value = await installation(resolve(root)); if (value) found.push(value); }
    return found;
  };
  const inspect = async (source: MediaSourceConfig, observed?: MediaSourceV1): Promise<MediaSetupSource> => {
    const base: MediaSetupSource = { id: source.id, kind: source.kind, label: source.label, state: 'available', message: '', canEnable: false,
      canDisable: false, managed: false, helperVersion: null, runtimeVersion: source.version ?? null, locations: [] };
    try {
      const found = await locations(source), chosen = found.length === 1 ? found[0]! : null;
      base.locations = found.map(item => ({ id: item.id, label: (found.length > 1 ? basename(dirname(item.root)) + '/' : '') + basename(item.root) + (item.version ? ' · ' + item.version : '') }));
      base.runtimeVersion = chosen?.version ?? base.runtimeVersion;
      base.managed = chosen?.managed ?? false; base.canDisable = base.managed;
      if (!found.length) return { ...base, state: 'ambiguous', message: 'Basic monitoring is available. Choose your ComfyUI folder in Advanced to enable detailed progress.' };
      if (found.length > 1) return { ...base, state: 'ambiguous', canEnable: found.some(item => item.version === '0.38.0'), message: 'Choose the ComfyUI installation you use for this connection.' };
      if (chosen!.version !== '0.38.0') return { ...base, state: 'unsupported', message: 'Basic monitoring is available. Detailed progress is qualified for ComfyUI 0.38.0.' };
      base.canEnable = true;
      if (observed && observed.state !== 'ready') return { ...base, state: 'offline', message: 'ComfyUI is not answering. Start it normally to resume monitoring.' };
      if (!chosen!.managed) return { ...base, message: 'Enable detailed progress to see measured work within each generation phase.' };
      base.helperVersion = MEDIA_HELPER_VERSION;
      if (observed?.capabilities.progress) return { ...base, state: 'ready', canEnable: false, message: 'Detailed media progress is ready.' };
      const token = chosen!.files.get('scope-token')?.trim(), origin = localOrigin(source.origin);
      if (!options.snapshot && token && origin) {
        try {
          const reply = await requestText({ url: new URL('/mlx-scope/v1/progress', origin), fetchImpl, timeoutMs: 1_500, maxBytes: 32_000,
            init: { headers: { Authorization: 'Bearer ' + token } } });
          const body = reply.status === 200 ? object(JSON.parse(reply.text)) : null;
          if (body?.schemaVersion === 1 && body.supported === true && body.helperVersion === MEDIA_HELPER_VERSION && body.comfyVersion === '0.38.0')
            return { ...base, state: 'ready', canEnable: false, message: 'Detailed media progress is ready.' };
        } catch {}
      }
      return { ...base, state: 'pending', message: 'Installed · activates next time ComfyUI starts. Basic monitoring continues.' };
    } catch (error) { return { ...base, state: 'error', message: error instanceof MediaSetupError ? error.message : 'The media installation could not be checked. Try again.' }; }
  };
  const status = async (): Promise<MediaSetupStatus> => {
    const text = await file(mediaConfigPath(options.home)), saved = text ? json(text) : null, enabled = saved?.enabled !== false;
    if (!enabled) return { schemaVersion: 1, enabled: false, sources: [] };
    const configurations = (await options.sources()).slice(0, 8);
    const observation = await options.snapshot?.();
    const sources = await Promise.all(configurations.map(async source => {
      const observed = observation?.sources.find(item => item.id === source.id);
      if (source.kind === 'comfyui') return inspect(source, observed);
      const ready = observed?.state === 'ready';
      return { id: source.id, kind: source.kind, label: source.label, enabled: true,
        state: ready ? 'ready' as const : observed?.state === 'unsupported' ? 'unsupported' as const : 'offline' as const,
        message: ready ? source.kind === 'local-video' ? 'Connected to your existing video queue.' : source.kind === 'feed' ? 'Connected to the private media feed.' : 'Connected to your image workflow.'
          : observed?.message ?? 'Source unavailable. Open its application or check its connection.',
        canEnable: false, canDisable: false, managed: false, helperVersion: null, runtimeVersion: null, locations: [] };
    }));
    for (const raw of Array.isArray(saved?.sources) ? saved.sources.slice(0, 8) : []) {
      const source = object(raw), id = mediaId(source?.id);
      if (!source || !id || source.enabled !== false || sources.some(item => item.id === id) || sources.length >= 8) continue;
      sources.push({ id, ...['comfyui','local-video','qwen-image','feed'].includes(String(source.kind)) ? {kind:source.kind as MediaSourceV1['kind']} : {}, label: safeLabel(source.label, 80) ?? 'Media connection', enabled: false, state: 'offline',
        message: 'Monitoring is paused for this connection.', canEnable: false, canDisable: false, managed: false, helperVersion: null, runtimeVersion: null, locations: [] });
    }
    return { schemaVersion: 1, enabled: true, sources };
  };
  const config = async (mutate: (value: RecordValue) => void): Promise<void> => {
    const path = mediaConfigPath(options.home), before = await file(path), value = before ? json(before) : { schemaVersion: 1, sources: [] };
    if (value.schemaVersion !== 1 || !Array.isArray(value.sources) || value.sources.length > 8) fail('The media configuration is not supported. Its contents were preserved.');
    mutate(value);
    await parents(dirname(path)); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await options.beforeCommit?.();
      if (await file(path) !== before) fail('The media configuration changed during setup. Try again; your changes were preserved.');
      await rename(temporary, path); options.invalidate(value.enabled !== false);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  };
  const saveSource = (source: RecordValue): Promise<void> => config(value => {
    const sources = value.sources as unknown[], index = sources.findIndex(item => object(item)?.id === source.id);
    if (index < 0 && sources.length >= 8) fail('Up to eight media connections are supported. Remove a connection before adding another.');
    if (index >= 0) sources[index] = { ...object(sources[index]), ...source }; else sources.push(source);
  });
  const change = async (input: MediaSetupAction): Promise<MediaSetupStatus> => {
    if (input.action === 'set-enabled' && input.sourceId === undefined) { await config(value => { value.enabled = input.enabled; }); return status(); }
    if (input.action === 'configure') {
      const origin = localOrigin(input.origin) ?? fail('Use a local ComfyUI address, such as http://127.0.0.1:8188.');
      let root: string | undefined;
      if (input.installationPath?.trim()) {
        root = resolve(input.installationPath.replace(/^~\//, options.home + '/'));
        if (!await installation(root)) fail('That folder does not contain a supported ComfyUI installation.');
      }
      const id = input.sourceId ?? 'comfy-' + hash(origin).slice(0, 12);
      const previous = (await options.sources()).find(source => source.id === id);
      if (previous && previous.kind !== 'comfyui') fail('That connection belongs to another media source.');
      await saveSource({ id, kind: 'comfyui', label: input.label?.trim() || previous?.label || 'ComfyUI', origin, enabled: true,
        ...root ? { installationPath: root } : {} });
      return status();
    }
    if (input.action === 'set-enabled' && input.enabled) {
      const text = await file(mediaConfigPath(options.home)), saved = text ? json(text) : null;
      const exists = (Array.isArray(saved?.sources) ? saved.sources : []).some(raw => object(raw)?.id === input.sourceId);
      if (exists) { await saveSource({ id: input.sourceId, enabled: true }); return status(); }
    }
    const source = (await options.sources()).find(item => item.id === input.sourceId);
    if (!source) fail('This media connection is no longer available. Refresh Connections.');
    if (input.action === 'set-enabled') { await saveSource({ ...source, enabled: input.enabled }); return status(); }
    if (source!.kind !== 'comfyui') fail('This source does not use the ComfyUI progress helper.');
    const found = await locations(source!), selected = input.locationId ? found.find(item => item.id === input.locationId) : found.length === 1 ? found[0] : null;
    if (!selected) fail('Choose the ComfyUI installation to update.');
    const target = selected!;
    if (input.action === 'enable' && target.version !== '0.38.0') fail('Detailed progress currently supports ComfyUI 0.38.0. Basic monitoring remains available.');
    const parent = dirname(target.directory); await parents(parent); await mkdir(parent, { recursive: true });
    const staged = join(parent, '.mlx-scope-' + randomUUID() + '.disabled'), backup = join(parent, '.mlx-scope-' + randomUUID() + '.disabled');
    let moved = false, installed = false, committed = false;
    try {
      if (input.action === 'enable') {
        const content: Record<string, string> = {};
        for (const name of MEDIA_HELPER_FILES) { const text = await file(join(options.bundleDirectory, name)); if (text === null) fail('The bundled media helper is missing. Update MLX Scope.'); content[name] = text!; }
        content['scope-token'] = target.files.get('scope-token') ?? randomBytes(32).toString('hex') + '\n';
        content[OWNER] = JSON.stringify({ owner: 'mlx-scope-comfyui', schemaVersion: 1, version: MEDIA_HELPER_VERSION,
          files: Object.fromEntries(Object.entries(content).map(([name, value]) => [name, hash(value)])) }) + '\n';
        await mkdir(staged, { mode: 0o700 });
        for (const [name, text] of Object.entries(content)) await writeFile(join(staged, name), text, { mode: 0o600, flag: 'wx' });
      } else if (!target.managed) fail('Only a helper installed by MLX Scope can be removed here.');
      await unchanged(target);
      if (target.exists) { await rename(target.directory, backup); moved = true; }
      if (input.action === 'enable') { await rename(staged, target.directory); installed = true; }
      await saveSource({ ...source, installationPath: target.root,
        helperTokenPath: input.action === 'enable' ? join(target.directory, 'scope-token') : undefined });
      committed = true;
      // A cleanup failure after the configuration commit must not restore an inconsistent old helper.
      // The task-owned .disabled backup is inert and remains recoverable if cleanup cannot complete.
      if (moved) await rm(backup, { recursive: true, force: true }).catch(() => {});
      options.invalidate();
    } catch (error) {
      if (!committed) {
        if (installed) await rm(target.directory, { recursive: true, force: true });
        if (moved) await rename(backup, target.directory);
      }
      throw error;
    } finally { await rm(staged, { recursive: true, force: true }).catch(() => {}); }
    return status();
  };
  return { status, async action(value: unknown): Promise<MediaSetupStatus> {
    const input = parseMediaSetupAction(value); if (!input) fail('The setup request is invalid.');
    const task = lock.then(() => change(input!)); lock = task.catch(() => {}); return task;
  } };
}
