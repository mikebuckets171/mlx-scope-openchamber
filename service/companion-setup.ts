import { applyEdits, createScanner, findNodeAtLocation, parse, parseTree, SyntaxKind, type ParseError } from 'jsonc-parser/lib/esm/main.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathsForHome } from './config.ts';
import { version as companionVersion } from '../bridge/opencode/package.json';
import { acceptsChatProtocol, acceptsRuntime, featureSupport, parseFeatures, type FeatureStatuses } from '../bridge/opencode/compatibility.js';
import { modeFor, profileFor, type CompatibilityMode } from '../bridge/opencode/qualified.js';

export const COMPANION_SETUP_PATH = '/v2/companion/setup';
export const COMPANION_ID = 'mlx-scope-prompt-progress';
/** The names Scope 5's guided setup recorded in its owner marker; anything else is never touched. */
const LEGACY_FILE = /^[A-Za-z0-9._-]{1,64}$/;
const OWNER = '.mlx-scope-owner.json', MAX_BYTES = 1_000_000;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** A startup receipt establishes the loaded version; only its expiring update proves current liveness. */
export interface CompanionProbe {
  companionVersion: string; protocol: string; runtimeVersion: string; supported: boolean; loadedAtMs: number;
  updatedAtMs?: number; expiresAtMs?: number;
  features?: FeatureStatuses;
}
export interface CompanionSetupStatus {
  state: 'disabled' | 'pending' | 'ready' | 'incompatible' | 'manual' | 'error';
  message: string; configured: boolean; managed: boolean; canEnable: boolean; canDisable: boolean;
  runtimeVersion: string | null; companionVersion: string | null; protocol: string | null; live: boolean;
  /** Qualification is independent of an installed helper's currently observed activity. */
  compatibility?: { profile: string | null; mode?: CompatibilityMode; activity: 'not-loaded' | 'awaiting-demand' | 'listening' | 'unavailable'; features: FeatureStatuses };
}
export interface CompanionSetupOptions {
  home?: string; env?: NodeJS.ProcessEnv; now?: () => number;
  probe?: () => Promise<CompanionProbe | null>;
  /** Whether no chat reply is being tracked or read right now. Without it the service never waits. */
  idle?: () => Promise<boolean>;
  /** Test seam for a competing config edit or an interrupted removal. */
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
/** The plugin list without Scope 5's entry. Comments, other plugins and the file's own commas and layout stay as they were. */
function withoutEntry(info: Inspection): string {
  const current = info.document.file?.text ?? '{\n}\n';
  if (info.entry < 0) return current;
  const tree = parseTree(current), array = tree && findNodeAtLocation(tree, ['plugins']);
  if (!array || array.type !== 'array') return fail('The plugin list changed. Try again.');
  const nodes = array.children ?? [], scanner = createScanner(current), commas: number[] = [];
  scanner.setPosition(array.offset + 1);
  for (let token = scanner.scan(); token !== SyntaxKind.EOF && scanner.getTokenOffset() < array.offset + array.length - 1; token = scanner.scan()) {
    const at = scanner.getTokenOffset();
    if (token === SyntaxKind.CommaToken && !nodes.some(node => at >= node.offset && at < node.offset + node.length)) commas.push(at);
  }
  const node = nodes[info.entry]!, end = node.offset + node.length;
  const comma = commas.find(at => at >= end && at < (nodes[info.entry + 1]?.offset ?? array.offset + array.length))
    ?? [...commas].reverse().find(at => at < node.offset);
  return applyEdits(current, [{ offset: node.offset, length: node.length, content: '' },
    ...comma !== undefined ? [{ offset: comma, length: 1, content: '' }] : []]);
}

/** What `retire` last found. `waiting` is a reply in progress or a setup in progress elsewhere; the next attempt tries again. */
export type Retirement = 'none' | 'removed' | 'waiting' | 'manual' | 'blocked' | 'error';
type Legacy = 'none' | 'present' | 'edited' | 'blocked';
const RETRY_MS = 30_000;

/**
 * From 6.0 the chat-speed helper is delivered by the extension itself, so nothing here installs, updates or disables it.
 * What remains is the helper Scope 5 wrote into OpenCode's own settings: `retire` removes that one entry and its files,
 * once, when they are exactly as Scope left them and no reply is being measured. Both copies carry the same plugin id and
 * OpenCode loads only the first, so until then the older helper keeps working as it did, and removing it lets the
 * one that came with the extension load in its place without a restart.
 */
export function createCompanionSetup(options: CompanionSetupOptions) {
  const now = options.now ?? Date.now, env = options.env ?? process.env;
  let work: Promise<unknown> = Promise.resolve(), attemptedAt = -Infinity, outcome: Retirement = 'none';
  const probe = async (): Promise<CompanionProbe | null> => { try { return await options.probe?.() ?? null; } catch { return null; } };
  /**
   * OpenChamber hands an extension's plugin only to the OpenCode it starts with its own configuration file. It does not
   * give an installed service its environment (only PATH, HOME, temp and locale are copied), so these are seen only by an
   * explicitly launched service: under OpenChamber the removal cannot tell how OpenCode was started.
   */
  const foreign = (): boolean => ['OPENCODE_CONFIG', 'OPENCODE_HOST', 'OPENCODE_PORT'].some(name => env[name]?.trim()) || /^(?:1|true)$/i.test(env.OPENCODE_SKIP_START?.trim() ?? '');
  const edited = (info: Inspection): boolean => {
    const owned = object(info.marker?.files) ?? {}, names = Object.keys(owned);
    return names.length === 0 || names.some(name => { const file = info.files.get(name); return !LEGACY_FILE.test(name) || !file || hash(file.text) !== owned[name]; })
      || [...info.files.keys()].some(name => name !== OWNER && !names.includes(name));
  };
  const legacyOf = (info: Inspection | null): Legacy => !info || !info.managed || info.entry < 0 ? 'none' : edited(info) ? 'edited' : foreign() ? 'blocked' : 'present';
  const describe = async (legacy: Legacy): Promise<CompanionSetupStatus> => {
    const receipt = await probe(), valid = receipt && Number.isFinite(receipt.loadedAtMs) && receipt.loadedAtMs > 0 && receipt.loadedAtMs <= now() + 1_000;
    const runtimeVersion = valid ? receipt.runtimeVersion.slice(0, 40) : null;
    const loadedCompanionVersion = valid ? receipt.companionVersion.slice(0, 40) : null, protocol = valid ? receipt.protocol.slice(0, 80) : null;
    const runtimeAccepted = acceptsRuntime(runtimeVersion);
    const qualified = valid && acceptsChatProtocol(receipt.runtimeVersion, receipt.protocol);
    const supported = qualified && receipt.supported;
    const current = supported && receipt.companionVersion === companionVersion;
    const live = !!(current && receipt.updatedAtMs && receipt.updatedAtMs <= now() + 1_000 && receipt.expiresAtMs && receipt.expiresAtMs > now() && receipt.expiresAtMs - receipt.updatedAtMs <= 15_000);
    const state = valid && !runtimeAccepted ? 'incompatible' : qualified && !supported ? 'error'
      : current ? 'ready' : legacy === 'edited' || legacy === 'blocked' ? 'manual' : 'pending';
    const message = state === 'incompatible' ? 'Chat estimates need OpenCode 2.0.25 or a later OpenCode 2 release. Runtime measurements remain available.'
      : state === 'error' ? 'Chat observation hooks are unavailable. Native runtime measurements remain available.'
      : state === 'ready' ? live ? 'Chat tracking is connected. Estimates follow the chat you are watching.' : 'Chat tracking is ready for your next reply.'
      : legacy === 'edited' ? 'An older chat-speed helper from MLX Scope 5 is still set up in OpenCode and its files were edited, so MLX Scope left it alone. Remove its entry from OpenCode’s plugins to use the helper that comes with this release.'
      : legacy === 'blocked' ? 'An older chat-speed helper from MLX Scope 5 is set up in an OpenCode that OpenChamber does not configure, so MLX Scope left it alone. It keeps working. Remove its entry once this extension’s plugin is added there.'
      : legacy === 'present' ? 'An older chat-speed helper from MLX Scope 5 is still loaded. MLX Scope switches to the one that comes with this release when no reply is being measured; your current work can continue.'
      : outcome === 'removed' ? 'Switched to the chat-speed helper that comes with this release · waiting for OpenCode to load it. Your current work can continue.'
      : 'Chat tracking starts when OpenChamber loads this extension’s helper into OpenCode. Your current work can continue.';
    return { state, message, configured: !!current, managed: legacy !== 'none', canEnable: false, canDisable: false,
      runtimeVersion, companionVersion: loadedCompanionVersion, protocol, live,
      compatibility: { profile: profileFor(runtimeVersion)?.id ?? null, mode: modeFor(runtimeVersion),
        activity: !valid ? 'not-loaded' : !supported ? 'unavailable' : !current ? 'not-loaded' : live ? 'listening' : 'awaiting-demand',
        features: parseFeatures(receipt?.features, runtimeVersion) ?? featureSupport(runtimeVersion) } };
  };
  /** Settings problems never surface here: the helper is the extension's now, and only a leftover Scope 5 entry reads them. */
  const inspected = async (): Promise<Inspection | null> => { try { return await inspect(options); } catch { return null; } };
  const retire = (): Promise<Retirement> => {
    const task = work.catch(() => {}).then(async (): Promise<Retirement> => {
      attemptedAt = now();
      let lock: Awaited<ReturnType<typeof open>> | undefined, lockPath: string | undefined, info: Inspection | null = null;
      try {
        info = await inspected();
        const legacy = legacyOf(info);
        if (legacy === 'none') return outcome = 'none';
        if (legacy === 'edited') return outcome = 'manual';
        if (legacy === 'blocked') return outcome = 'blocked';
        if (!await (options.idle?.() ?? Promise.resolve(true)).catch(() => false)) return outcome = 'waiting';
        await safeParents(info!.root);
        const candidate = join(info!.root, '.mlx-scope-setup.lock');
        lock = await setupLock(candidate); lockPath = candidate;
        await checkUnchanged(info!.document);
        await checkInstallation(info!);
        const text = withoutEntry(info!), owned = Object.entries(object(info!.marker?.files) ?? {});
        await options.beforeConfigCommit?.();
        await commitConfig(info!.document, text);
        // The entry is gone and OpenCode has been told by the rename. Each file is read once more: one edited since the checks above stays.
        for (const [name, digest] of owned) {
          const path = join(info!.addon, name), file = await readFile(path);
          if (file && hash(file.text) === digest) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
        await unlink(join(info!.addon, OWNER)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await rmdir(info!.addon).catch(error => { if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error; });
        return outcome = 'removed';
      } catch (error) { return outcome = error instanceof SetupError ? 'waiting' : 'error'; }
      finally { await lock?.close(); if (lockPath) await unlink(lockPath).catch(() => {}); }
    });
    work = task;
    return task;
  };
  const status = async (): Promise<CompanionSetupStatus> => describe(legacyOf(await inspected()));
  /**
   * Called as a view polls, so a removal that had to wait for a reply to finish is tried again without a timer: at most every
   * RETRY_MS, only after a wait, and never waited for. Reading status itself never changes anything.
   */
  const retry = (): void => { if (outcome === 'waiting' && now() - attemptedAt >= RETRY_MS) void retire(); };
  return { status, retire, retry };
}
