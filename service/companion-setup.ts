import { applyEdits, createScanner, findNodeAtLocation, modify, parse, parseTree, SyntaxKind, type ParseError } from 'jsonc-parser/lib/esm/main.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLocalOrigin, pathsForHome } from './config.ts';
import { hintFor } from './core/hints.ts';
import { version as companionVersion } from '../bridge/opencode/package.json';

export const COMPANION_SETUP_PATH = '/v2/companion/setup';
export const COMPANION_ID = 'mlx-scope-prompt-progress';
export const COMPANION_FILES = ['package.json', 'README.md', 'index.js', 'store.js', 'stream.js', 'chat.js', 'demand.js', 'chat-store.js'] as const;
const OWNER = '.mlx-scope-owner.json', MAX_BYTES = 1_000_000;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** A startup receipt establishes the loaded version; only its expiring update proves current liveness. */
export interface CompanionProbe {
  companionVersion: string; protocol: string; runtimeVersion: string; supported: boolean; loadedAtMs: number;
  updatedAtMs?: number; expiresAtMs?: number;
}
export interface CompanionSetupStatus {
  state: 'disabled' | 'pending' | 'ready' | 'incompatible' | 'manual' | 'error';
  message: string; configured: boolean; managed: boolean; canEnable: boolean; canDisable: boolean;
  runtimeVersion: string | null; companionVersion: string | null; protocol: string | null; live: boolean;
}
export interface CompanionSetupOptions {
  /** The shipped bridge/opencode directory, resolved by the service entry point. Never accepted from HTTP input. */
  bundleDirectory: string;
  home?: string; env?: NodeJS.ProcessEnv; now?: () => number;
  probe?: () => Promise<CompanionProbe | null>;
  /** Test seam for a competing config edit or an interrupted installation. */
  beforeConfigCommit?: () => Promise<void>;
}
type File = { text: string; mode: number };
type Document = { path: string; file: File | null; value: ObjectValue };
type Inspection = { root: string; addon: string; document: Document; documents: Document[]; entry: number; managed: boolean; files: Map<string, File>; marker: ObjectValue | null };
class SetupError extends Error {}
const fail = (message: string): never => { throw new SetupError(message); };

/** No symlink component, devices, hard links, or files owned by another account are writable setup inputs. */
async function safeParents(path: string): Promise<void> {
  if (!isAbsolute(path)) fail('Setup needs an absolute OpenCode configuration path.');
  for (let current = path; current !== dirname(current); current = dirname(current)) {
    try { const info = await lstat(current); if (info.isSymbolicLink() || !info.isDirectory()) fail('Setup cannot use a linked configuration directory.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
async function readFile(path: string): Promise<File | null> {
  await safeParents(dirname(path));
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES || process.getuid && info.uid !== process.getuid()) fail('Setup found an unsafe or oversized file.');
    const bytes = Buffer.alloc(info.size + 1), result = await handle.read(bytes, 0, bytes.length, 0), after = await handle.stat();
    if (result.bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) fail('A setup file changed while it was read. Try again.');
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, result.bytesRead)), mode: info.mode & 0o777 };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}
function json(text: string): ObjectValue {
  const errors: ParseError[] = [], value = object(parse(text, errors, { allowTrailingComma: true }));
  if (errors.length || !value) fail('OpenCode configuration is not valid JSON or JSONC. Correct it before enabling the companion.');
  return value!;
}
async function document(path: string): Promise<Document> {
  const file = await readFile(path), value = file ? json(file.text) : {};
  if (value.plugins !== undefined && !Array.isArray(value.plugins)) fail('OpenCode’s plugins setting must be a list.');
  if (file && (parseTree(file.text)?.children ?? []).filter(node => node.children?.[0]?.value === 'plugins').length > 1) fail('OpenCode configuration contains duplicate plugin lists. Keep one list before using guided setup.');
  return { path, file, value };
}
function packagePath(entry: unknown, root: string): string | null {
  const value = typeof entry === 'string' ? entry : object(entry)?.package;
  if (typeof value !== 'string') return null;
  try { return value.startsWith('file:') ? resolve(fileURLToPath(value)) : isAbsolute(value) ? resolve(value) : value.startsWith('./') || value.startsWith('../') ? resolve(root, value) : null; }
  catch { return null; }
}
function matching(entry: unknown, addon: string, root: string): boolean { return packagePath(entry, root) === addon; }
function foreignCompanion(entry: unknown, addon: string, root: string): boolean {
  const name = typeof entry === 'string' ? entry : object(entry)?.package;
  return typeof name === 'string' && (name === COMPANION_ID || basename(name.replace(/\/+$/, '')) === COMPANION_ID)
    && !matching(entry, addon, root);
}
async function inspect(options: CompanionSetupOptions): Promise<Inspection> {
  const env = options.env ?? process.env, home = options.home ?? homedir();
  if (!isAbsolute(home) || ['XDG_CONFIG_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG'].some(key => env[key]?.trim() && !isAbsolute(env[key]!))) fail('Setup needs absolute OpenCode configuration paths.');
  if (env.OPENCODE_CONFIG_CONTENT?.trim()) fail('OpenCode uses an inline configuration. Add the companion through that configuration manually.');
  const paths = pathsForHome(home, env), root = dirname(paths.openCode), addon = join(root, 'addons', COMPANION_ID);
  await safeParents(root);
  const names = [paths.openCode, paths.openCodeJSONC];
  const override = env.OPENCODE_CONFIG?.trim();
  if (override) {
    const rel = relative(root, override);
    if (rel.startsWith('..') || isAbsolute(rel)) fail('OpenCode uses a configuration outside its global directory. Manage the companion in that configuration manually.');
    if (!names.includes(override)) names.push(override);
  }
  const documents = await Promise.all(names.map(document));
  const matches = documents.flatMap(doc => ((doc.value.plugins as unknown[] | undefined) ?? []).flatMap((entry, index) => matching(entry, addon, dirname(doc.path)) ? [{ doc, index }] : []));
  if (matches.length > 1) fail('Several companion entries exist. Keep one entry in OpenCode before using guided setup.');
  if (documents.some(doc => ((doc.value.plugins as unknown[] | undefined) ?? []).some(entry => foreignCompanion(entry, addon, dirname(doc.path))))) fail('A companion is configured at another location. Manage that installation manually to avoid adding a second observer.');
  const chosen = matches[0]?.doc ?? [...documents].reverse().find(doc => doc.file) ?? documents[0]!;
  // A plugins list in a later config can override an earlier one; do not modify the wrong document.
  if (matches.length && documents.slice(documents.indexOf(chosen) + 1).some(doc => doc.value.plugins !== undefined)) fail('A later OpenCode configuration overrides the companion’s plugin list. Manage that entry manually.');
  await safeParents(addon);
  const files = new Map<string, File>();
  try {
    const entries = await readdir(addon, { withFileTypes: true });
    if (entries.length > 32) fail('The companion directory contains additional files. Manage that installation manually.');
    for (const item of entries) {
      if (!item.isFile()) fail('The companion directory contains linked files or folders. Manage that installation manually.');
      const value = await readFile(join(addon, item.name)); if (!value) fail('The companion installation changed. Try again.'); files.set(item.name, value!);
    }
    if ([...files.values()].reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) > 4 * MAX_BYTES) fail('The companion directory is too large for guided setup.');
    if (json(files.get('package.json')?.text ?? '{}').name !== COMPANION_ID) fail('Another package occupies the companion directory. Its files were left unchanged.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const marker = files.has(OWNER) ? json(files.get(OWNER)!.text) : null;
  const managed = marker?.owner === COMPANION_ID && marker.schemaVersion === 1 && object(marker.files) !== null;
  return { root, addon, document: chosen, documents, entry: matches[0]?.index ?? -1, managed, files, marker };
}
function initialOptions(documents: Document[]): ObjectValue {
  const merged = { provider: new Map<string, ObjectValue>(), providers: new Map<string, ObjectValue>() };
  for (const doc of documents) for (const field of ['provider', 'providers'] as const) {
    const container = doc.value[field];
    if (container !== undefined && !object(container)) { merged[field].clear(); continue; }
    for (const [id, raw] of Object.entries(object(container) ?? {})) {
      const provider = object(raw), previous = merged[field].get(id);
      if (!provider) { merged[field].delete(id); continue; }
      const settings = field === 'providers' ? 'settings' : 'options';
      merged[field].set(id, { ...previous, ...provider,
        ...(provider[settings] !== undefined ? { [settings]: object(provider[settings]) ? { ...object(previous?.[settings]), ...object(provider[settings]) } : provider[settings] } : {}) });
    }
  }
  const candidates = new Map<string, ObjectValue>();
  for (const field of ['provider', 'providers'] as const) {
    for (const [id, provider] of merged[field]) {
      candidates.delete(id); // OpenCode 2 entries supersede same-ID legacy providers, including remote ones.
      const settings = object(provider[field === 'providers' ? 'settings' : 'options']);
      const endpoint = parseLocalOrigin(settings?.baseURL);
      if (endpoint && /^[a-zA-Z0-9_-]{1,80}$/.test(id) && hintFor(id, provider.name) === 'splash') candidates.set(id, { providerID: id, baseURL: `${endpoint.origin}/v1` });
    }
  }
  return candidates.size === 1 ? [...candidates.values()][0]! : { promptProgress: false };
}
function configText(info: Inspection, enabled: boolean, revision?: string): string {
  const current = info.document.file?.text ?? '{\n}\n';
  if (!enabled && info.entry < 0) return current;
  const formattingOptions = { insertSpaces: !/^\t/m.test(current), tabSize: 2, eol: current.includes('\r\n') ? '\r\n' : '\n' };
  const plugins = info.document.value.plugins as unknown[] | undefined;
  if (enabled && info.entry >= 0) {
    const entry = plugins![info.entry], configured = object(entry);
    if (configured?.options !== undefined && !object(configured.options)) return fail('Companion options must be an object before using guided setup. Existing configuration was preserved.');
    // Renamed files trigger the reload; the content revision on our own entry keeps the old
    // and new plugin instances' shared state apart and marks the change in the config.
    if (object(configured?.options)?.scopeRevision === revision) return current;
    return applyEdits(current, modify(current, typeof entry === 'string' ? ['plugins', info.entry] : ['plugins', info.entry, 'options', 'scopeRevision'],
      typeof entry === 'string' ? { package: entry, options: { scopeRevision: revision } } : revision, { formattingOptions }));
  }
  const value = enabled ? { package: info.addon, options: { ...initialOptions(info.documents), scopeRevision: revision } } : undefined;
  if (plugins) {
    const tree = parseTree(current), array = tree && findNodeAtLocation(tree, ['plugins']);
    if (!array || array.type !== 'array') return fail('The plugin list changed. Try again.');
    const nodes = array.children ?? [], scanner = createScanner(current), commas: number[] = [];
    scanner.setPosition(array.offset + 1);
    for (let token = scanner.scan(); token !== SyntaxKind.EOF && scanner.getTokenOffset() < array.offset + array.length - 1; token = scanner.scan()) {
      const at = scanner.getTokenOffset();
      if (token === SyntaxKind.CommaToken && !nodes.some(node => at >= node.offset && at < node.offset + node.length)) commas.push(at);
    }
    if (!enabled) {
      const node = nodes[info.entry]!, end = node.offset + node.length;
      const comma = commas.find(at => at >= end && at < (nodes[info.entry + 1]?.offset ?? array.offset + array.length))
        ?? [...commas].reverse().find(at => at < node.offset);
      return applyEdits(current, [{ offset: node.offset, length: node.length, content: '' },
        ...comma !== undefined ? [{ offset: comma, length: 1, content: '' }] : []]);
    }
    const last = nodes.at(-1), end = last ? last.offset + last.length : array.offset + 1;
    const eol = current.includes('\r\n') ? '\r\n' : '\n';
    const close = array.offset + array.length - 1, needsComma = !!last && !commas.some(at => at >= end);
    return applyEdits(current, [{ offset: close, length: 0, content: `${needsComma && end === close ? ',' : ''}${eol}    ${JSON.stringify(value)}${eol}  ` },
      ...needsComma && end !== close ? [{ offset: end, length: 0, content: ',' }] : []]);
  }
  return applyEdits(current, modify(current, ['plugins'], [value], { formattingOptions }));
}
async function checkUnchanged(doc: Document): Promise<void> {
  const current = await readFile(doc.path);
  if (current?.text !== doc.file?.text || current?.mode !== doc.file?.mode) fail('OpenCode configuration changed during setup. Try again; your changes were preserved.');
}
async function commitConfig(doc: Document, text: string): Promise<void> {
  await checkUnchanged(doc);
  if (text === doc.file?.text) return;
  const temporary = join(dirname(doc.path), `.mlx-scope-config-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: doc.file?.mode ?? 0o600 });
    await checkUnchanged(doc); await rename(temporary, doc.path);
  } finally { await unlink(temporary).catch(() => {}); }
}
async function removeFlat(directory: string): Promise<void> {
  for (const name of await readdir(directory)) await unlink(join(directory, name));
  await rmdir(directory);
}
// Dependencies before the entry point, the marker last: a reload between renames never sees a newer entry over older modules.
const replaceOrder = (name: string): number => name === OWNER ? 3 : name === 'package.json' ? 2 : name === 'index.js' ? 1 : 0;
/**
 * OpenCode 2.0.25 reloads a plugin when a loaded file is replaced by rename; an in-place write, or a directory swapped
 * underneath its watches, is not observed. Each changed file is staged beside its target and renamed over it, so the
 * addon directory keeps its identity. Unchanged files are left alone. `replaced` records each committed name for rollback.
 */
async function replaceFiles(directory: string, files: Map<string, File>, previous: Map<string, File>, replaced: string[]): Promise<void> {
  const changed = [...files].filter(([name, file]) => previous.get(name)?.text !== file.text || previous.get(name)?.mode !== file.mode)
    .sort(([a], [b]) => replaceOrder(a) - replaceOrder(b));
  const staged: Array<[string, string]> = [];
  try {
    for (const [name, file] of changed) {
      const temporary = join(directory, `.mlx-scope-update-${randomUUID()}.tmp`); staged.push([name, temporary]);
      await writeFile(temporary, file.text, { flag: 'wx', mode: file.mode });
    }
    for (const [name, temporary] of staged) { await rename(temporary, join(directory, name)); replaced.push(name); }
  } finally { for (const [, temporary] of staged) await unlink(temporary).catch(() => {}); }
}
/** Restores replaced files to their earlier bytes (by the same rename) and removes files this setup added. */
async function restoreFiles(directory: string, replaced: string[], previous: Map<string, File>): Promise<void> {
  const earlier = new Map(replaced.flatMap(name => previous.has(name) ? [[name, previous.get(name)!] as const] : []));
  await replaceFiles(directory, earlier, new Map(), []);
  for (const name of replaced) if (!previous.has(name)) await unlink(join(directory, name)).catch(() => {});
}
async function checkInstallation(info: Inspection): Promise<void> {
  const names = await readdir(info.addon).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  if (names.length !== info.files.size || names.some(name => !info.files.has(name))) fail('The companion installation changed during setup. Try again.');
  for (const [name, original] of info.files) {
    const current = await readFile(join(info.addon, name));
    if (current?.text !== original.text || current.mode !== original.mode) fail('The companion installation changed during setup. Try again.');
  }
}
async function setupLock(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ owner: COMPANION_ID, pid: process.pid })); return handle; }
      catch (error) { await handle.close(); await unlink(path).catch(() => {}); throw error; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = await readFile(path), value = previous ? object(parse(previous.text)) : null;
      if (value?.owner !== COMPANION_ID || !Number.isSafeInteger(value.pid) || (value.pid as number) < 2) break;
      try { process.kill(value.pid as number, 0); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') break;
        // A crashed setup cannot leave a permanent lock; never remove a replaced/live lock.
        if ((await readFile(path))?.text !== previous!.text) break;
        await unlink(path);
      }
    }
  }
  return fail('Another companion setup is in progress. Try again after it finishes.');
}
async function prepareBundle(options: CompanionSetupOptions, info: Inspection, at: number): Promise<Map<string, File>> {
  if (!isAbsolute(options.bundleDirectory)) fail('The companion bundle path is unavailable.');
  const files = new Map(info.files);
  for (const name of COMPANION_FILES) {
    const file = await readFile(join(options.bundleDirectory, name)); if (!file) fail('The installed MLX Scope package is missing companion files. Reinstall MLX Scope.');
    files.set(name, { text: file!.text, mode: 0o600 });
  }
  if (info.managed) for (const name of COMPANION_FILES) {
    const previous = info.files.get(name), digest = object(info.marker?.files)?.[name];
    // A file that already holds this bundle's bytes is an interrupted update finishing, not a user edit.
    if (previous && digest && hash(previous.text) !== digest && previous.text !== files.get(name)!.text) fail('Companion files were edited after installation. Keep those changes elsewhere before updating through Scope.');
  }
  if (json(files.get('package.json')!.text).name !== COMPANION_ID) fail('The bundled companion has an unexpected identity.');
  const unchanged = info.managed && COMPANION_FILES.every(name => info.files.get(name)?.text === files.get(name)?.text);
  const installedAtMs = unchanged && typeof info.marker?.installedAtMs === 'number' ? info.marker.installedAtMs : at;
  files.set(OWNER, { text: JSON.stringify({ schemaVersion: 1, owner: COMPANION_ID, installedAtMs, files: Object.fromEntries(COMPANION_FILES.map(name => [name, hash(files.get(name)!.text)])) }), mode: 0o600 });
  return files;
}
/** Only explicit enable/disable calls write. Status performs bounded local reads, never a CLI or runtime request. */
export function createCompanionSetup(options: CompanionSetupOptions) {
  const now = options.now ?? Date.now;
  let work: Promise<unknown> = Promise.resolve();
  const probe = async (): Promise<CompanionProbe | null> => { try { return await options.probe?.() ?? null; } catch { return null; } };
  /** A managed installation recorded with other bytes than this bundle needs the guided update, even at the same version. */
  const outdated = async (info: Inspection): Promise<boolean> => {
    const owned = object(info.marker?.files);
    if (!info.managed || !owned) return false;
    for (const name of COMPANION_FILES) {
      const file = await readFile(join(options.bundleDirectory, name)).catch(() => null);
      if (!file || owned[name] !== hash(file.text)) return true;
    }
    return false;
  };
  const describe = async (info: Inspection): Promise<CompanionSetupStatus> => {
    const receipt = await probe(), valid = receipt && Number.isFinite(receipt.loadedAtMs) && receipt.loadedAtMs > 0 && receipt.loadedAtMs <= now() + 1_000;
    const runtimeVersion = valid ? receipt.runtimeVersion.slice(0, 40) : null;
    const loadedCompanionVersion = valid ? receipt.companionVersion.slice(0, 40) : null, protocol = valid ? receipt.protocol.slice(0, 80) : null;
    const supported = valid && receipt.supported && receipt.protocol === 'opencode-2.0.25' && receipt.runtimeVersion === '2.0.25';
    const configured = info.entry >= 0, installedAt = typeof info.marker?.installedAtMs === 'number' ? info.marker.installedAtMs : 0;
    const stale = configured && await outdated(info);
    const needsUpdate = configured && (stale || json(info.files.get('package.json')?.text ?? '{}').version !== companionVersion);
    const current = supported && !stale && receipt.companionVersion === companionVersion && receipt.loadedAtMs >= installedAt;
    const live = !!(current && receipt.updatedAtMs && receipt.updatedAtMs <= now() + 1_000 && receipt.expiresAtMs && receipt.expiresAtMs > now() && receipt.expiresAtMs - receipt.updatedAtMs <= 15_000);
    const state = valid && !supported ? 'incompatible' : configured ? current ? 'ready' : 'pending' : 'disabled';
    const message = state === 'incompatible' ? 'This OpenCode version is not qualified for chat estimates. Runtime measurements remain available.'
      : state === 'ready' ? live ? 'Chat tracking is connected. Estimates follow the chat you are watching.' : 'Chat tracking is ready for your next reply.'
        : state === 'pending' ? needsUpdate ? 'Update chat speed to install the current tracking helper.'
          : 'Installed · waiting for OpenCode to load the updated tracking helper. Your current work can continue.'
          : 'Enable delivery-speed estimates for local and cloud chats. Requires OpenCode 2.0.25.';
    return { state, message, configured, managed: info.managed, canEnable: state !== 'incompatible', canDisable: configured || info.managed,
      runtimeVersion, companionVersion: loadedCompanionVersion, protocol, live };
  };
  const errorStatus = (error: unknown): CompanionSetupStatus => ({ state: error instanceof SetupError ? 'manual' : 'error',
    message: error instanceof SetupError ? error.message : 'Companion setup could not finish. Existing configuration was preserved; check local file access and try again.',
    configured: false, managed: false, canEnable: false, canDisable: false, runtimeVersion: null, companionVersion: null, protocol: null, live: false });
  const status = async (): Promise<CompanionSetupStatus> => { try { return await describe(await inspect(options)); } catch (error) { return errorStatus(error); } };
  const change = (enabled: boolean): Promise<CompanionSetupStatus> => {
    const task = work.catch(() => {}).then(async () => {
      let lock: Awaited<ReturnType<typeof open>> | undefined, lockPath: string | undefined;
      let created = false, configCommitted = false, info: Inspection | undefined;
      const replaced: string[] = [];
      try {
        info = await inspect(options);
        if (enabled && (await describe(info)).state === 'incompatible') return describe(info);
        const files = enabled ? await prepareBundle(options, info, now()) : null;
        await safeParents(info.root); await mkdir(info.root, { recursive: true, mode: 0o700 });
        const candidate = join(info.root, '.mlx-scope-setup.lock');
        lock = await setupLock(candidate); lockPath = candidate;
        await checkUnchanged(info.document);
        await checkInstallation(info);
        const revision = files ? hash(JSON.stringify(COMPANION_FILES.map(name => [name, hash(files.get(name)!.text)]))) : undefined;
        const text = configText(info, enabled, revision);
        if (enabled) {
          await safeParents(dirname(info.addon)); await mkdir(dirname(info.addon), { recursive: true, mode: 0o700 });
          created = await mkdir(info.addon, { mode: 0o700 }).then(() => true, error => { if (error.code === 'EEXIST') return false; throw error; });
          await safeParents(info.addon);
          await replaceFiles(info.addon, files!, info.files, replaced);
          await options.beforeConfigCommit?.();
          await commitConfig(info.document, text);
          configCommitted = true;
        } else {
          await options.beforeConfigCommit?.(); await commitConfig(info.document, text); configCommitted = true;
          // Modified or unowned files survive removal. A manual legacy install is disabled, never deleted.
          if (info.managed) {
            const owned = object(info.marker?.files)!;
            for (const name of COMPANION_FILES) {
              const path = join(info.addon, name), file = await readFile(path);
              if (file && owned[name] === hash(file.text)) await unlink(path);
            }
            await unlink(join(info.addon, OWNER));
            await rmdir(info.addon).catch(error => { if (error.code !== 'ENOTEMPTY') throw error; });
          }
        }
        const result = await status();
        return !enabled ? { ...result, state: 'disabled' as const, configured: false, canDisable: false,
          message: result.state === 'manual' ? 'Companion disabled. Your modified files were preserved; move them before reinstalling through Scope.'
            : 'Companion disabled. OpenCode applies the configuration change normally; runtime measurements remain available.' } : result;
      } catch (error) {
        if (enabled && info && !configCommitted) {
          if (created) await removeFlat(info.addon).catch(() => {});
          else await restoreFiles(info.addon, replaced, info.files).catch(() => {});
        }
        return configCommitted ? { ...errorStatus(error), message: 'Companion configuration was updated, but installation cleanup could not finish. Check local file access, then check status before trying again.' } : errorStatus(error);
      } finally {
        await lock?.close(); if (lockPath) await unlink(lockPath).catch(() => {});
      }
    });
    work = task;
    return task;
  };
  return { status, enable: () => change(true), disable: () => change(false) };
}
