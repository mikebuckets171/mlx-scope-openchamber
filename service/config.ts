import { parse, type ParseError } from 'jsonc-parser/lib/esm/main.js';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { runtimeValue, type Runtime } from '../src/runtime.ts';

type JsonObject = { readonly [key: string]: unknown };

export type OmlxConfig = {
  baseURL: URL | null;
  apiKey: string | null;
  preferredModel: string | null;
  error: string | null;
  issue: ConfigIssue;
  source: ConfigSource;
  configStatus: ConfigStatus;
  authStatus: ConfigStatus;
};

export type ConfigIssue =
  | 'none'
  | 'missing_endpoint'
  | 'missing_credential'
  | 'malformed_config'
  | 'unreadable_config'
  | 'invalid_endpoint'
  | 'unsupported_config';

export type ConfigSource = 'environment' | 'opencode' | 'omlx' | null;
export type ConfigStatus = 'present' | 'missing' | 'unreadable' | 'malformed';

export type ConfigPaths = {
  openCode: string;
  openCodeJSONC: string;
  omlx: string;
  auth: string;
};

type ReadTextResult =
  | { kind: 'ok'; text: string }
  | { kind: 'missing' }
  | { kind: 'unreadable' };

export type ConfigInput = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** The string/null form remains accepted as a small test seam. */
  readText?: (path: string) => Promise<ReadTextResult | string | null>;
};

type Document = {
  status: 'ok' | 'missing' | 'unreadable' | 'malformed';
  value: JsonObject | null;
};

const asObject = (value: unknown): JsonObject | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
);

const nonempty = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

type ReadText = ReadTextResult | string | null;

const normalizeReadText = (content: ReadText): ReadTextResult => {
  if (typeof content === 'string') return { kind: 'ok', text: content };
  return content ?? { kind: 'missing' };
};

const readJson = async (path: string, readText: (path: string) => Promise<ReadText>): Promise<Document> => {
  const content = normalizeReadText(await readText(path));
  if (content.kind !== 'ok') return { status: content.kind, value: null };
  const errors: ParseError[] = [];
  const value = asObject(parse(content.text, errors, { allowTrailingComma: true }));
  return errors.length === 0 && value !== null
    ? { status: 'ok', value }
    : { status: 'malformed', value: null };
};

const defaultReadText = async (path: string): Promise<ReadTextResult> => {
  try {
    // Do not wait for a writer when an invalid configuration path is a FIFO.
    const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const limit = 1_000_000;
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limit) return { kind: 'unreadable' };
      const buffer = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return offset !== stat.size ? { kind: 'unreadable' } : { kind: 'ok', text: buffer.toString('utf8', 0, offset) };
    } finally { await handle.close(); }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable' };
  }
};

export const pathsForHome = (home: string, env: NodeJS.ProcessEnv = {}): ConfigPaths => {
  const configRoot = nonempty(env.XDG_CONFIG_HOME);
  const dataRoot = nonempty(env.XDG_DATA_HOME);
  const configHome = configRoot && isAbsolute(configRoot) ? configRoot : join(home, '.config');
  const dataHome = dataRoot && isAbsolute(dataRoot) ? dataRoot : join(home, '.local', 'share');
  const openCodeHome = join(configHome, 'opencode');
  return {
    openCode: join(openCodeHome, 'opencode.json'),
    openCodeJSONC: join(openCodeHome, 'opencode.jsonc'),
    omlx: join(home, '.omlx', 'settings.json'),
    auth: join(dataHome, 'opencode', 'auth.json'),
  };
};

const statusOf = (documents: readonly Document[]): ConfigStatus => {
  if (documents.some((document) => document.status === 'malformed')) return 'malformed';
  if (documents.some((document) => document.status === 'unreadable')) return 'unreadable';
  if (documents.some((document) => document.status === 'ok')) return 'present';
  return 'missing';
};

const has = (value: JsonObject | null, key: string): boolean => (
  value !== null && Object.prototype.hasOwnProperty.call(value, key)
);

const merge = (base: JsonObject, overlay: JsonObject): JsonObject => {
  const result: Record<string, unknown> = Object.assign(Object.create(null), base);
  for (const [key, value] of Object.entries(overlay)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    const previous = asObject(result[key]);
    const next = asObject(value);
    result[key] = previous !== null && next !== null ? merge(previous, next) : value;
  }
  return result;
};

export type RuntimeConnectionConfig = {
  id: string;
  label: string;
  runtime: Runtime | null;
  config: OmlxConfig;
};
export type RuntimeConnections = { connections: RuntimeConnectionConfig[]; error: string | null; issue: ConfigIssue; configStatus?: ConfigStatus; authStatus?: ConfigStatus };

/** Canonicalize localhost without DNS; credentials never leave numeric loopback. */
export const parseLocalOrigin = (value: unknown): URL | null => {
  const raw = nonempty(value);
  if (!raw || !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}(?:\/v1\/?)?\/?$/.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw.replace('://localhost:', '://127.0.0.1:')); } catch { return null; }
  if (url.port === '0') return null;
  url.pathname = '/';
  return url;
};

const hintFor = (id: string, name: unknown): Runtime | null => {
  const value = `${id} ${typeof name === 'string' ? name : ''}`.toLowerCase();
  if (/vllm[\s_-]*mlx/.test(value)) return 'vllm-mlx';
  if (/omlx/.test(value)) return 'omlx';
  if (/lm[\s_-]*studio/.test(value)) return 'lmstudio';
  return /mlx[\s_-]*lm/.test(value) ? 'mlx-lm' : null;
};
const safeLabel = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
const issueText = (issue: ConfigIssue): string | null => ({
  none: null,
  missing_endpoint: 'No local runtime connection found. Add your runtime as a provider in OpenChamber; saved connections are discovered automatically.',
  missing_credential: 'No saved API key. Key-free access works only when the runtime already permits it.',
  malformed_config: 'An existing provider configuration is malformed. Correct it in OpenChamber, then return here.',
  unreadable_config: 'An existing provider configuration or credential file could not be read.',
  invalid_endpoint: 'The selected connection needs an HTTP loopback URL with an explicit port, such as http://localhost:8000/v1.',
  unsupported_config: 'A configured credential or endpoint reference could not be resolved. Reconnect this provider in OpenChamber.',
})[issue];

export const resolveRuntimeConnections = async ({ env = process.env, home = env.HOME ?? homedir(), readText = defaultReadText }: ConfigInput = {}): Promise<RuntimeConnections> => {
  const paths = pathsForHome(home, env), override = nonempty(env.OPENCODE_CONFIG);
  const names = [join(dirname(paths.openCode), 'config.json'), paths.openCode, paths.openCodeJSONC];
  if (override && isAbsolute(override)) names.push(override);
  const documents = await Promise.all(names.map(async path => ({ path, document: await readJson(path, readText) })));
  const inline = nonempty(env.OPENCODE_CONFIG_CONTENT);
  if (inline) documents.push({ path: 'OPENCODE_CONFIG_CONTENT', document: inline.length > 1_000_000
    ? { status: 'unreadable', value: null } : await readJson('OPENCODE_CONFIG_CONTENT', async () => inline) });
  const native = await readJson(paths.omlx, readText);
  let auth: Document;
  const inlineAuth = nonempty(env.OPENCODE_AUTH_CONTENT);
  if (inlineAuth) {
    try {
      const value = inlineAuth.length <= 1_000_000 ? asObject(JSON.parse(inlineAuth)) : null;
      auth = { status: value ? 'ok' : 'malformed', value };
    } catch { auth = { status: 'malformed', value: null }; }
  } else auth = await readJson(paths.auth, readText);
  const configStatus = statusOf(documents.map(item => item.document));
  const authStatus = statusOf([auth]);
  const problem = documents.find(item => ['unreadable', 'malformed'].includes(item.document.status));
  const envBase = nonempty(env.MLX_SCOPE_BASE_URL);
  const fileIssue: ConfigIssue = override && !isAbsolute(override) ? 'unsupported_config'
    : problem?.document.status === 'malformed' ? 'malformed_config' : problem ? 'unreadable_config' : 'none';
  if (fileIssue !== 'none' && !envBase) return { connections: [], issue: fileIssue, error: issueText(fileIssue), configStatus, authStatus };
  const merged = documents.filter(item => item.document.value).reduce<JsonObject>((result, item) => merge(result, item.document.value!), {});
  const providers = asObject(merged.provider) ?? {};
  const selected = nonempty(merged.model)?.split('/')[0] ?? null;
  const nativeServer = asObject(native.value?.server);
  const nativePort = nativeServer?.port;
  const nativeHost = nonempty(nativeServer?.host) ?? '127.0.0.1';
  const nativeOrigin = typeof nativePort === 'number' && Number.isInteger(nativePort)
    ? parseLocalOrigin(`http://${nativeHost === '0.0.0.0' ? '127.0.0.1' : nativeHost === '::1' ? '[::1]' : nativeHost}:${nativePort}`) : null;

  const expand = async (value: unknown, sourcePath: string): Promise<string | null> => {
    let result = nonempty(value);
    if (!result || result.length > 16_384) return null;
    let missing = false;
    result = result.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, first, second) => {
      const replacement = nonempty(env[first ?? second]);
      if (replacement === null) missing = true;
      return replacement ?? '';
    });
    if (missing || result.length > 16_384) return null;
    const references = [...result.matchAll(/\{file:([^}]+)\}/g)];
    if (references.length > 4) return null;
    let expanded = '', offset = 0;
    for (const reference of references) {
      const name = reference[1]!;
      if (sourcePath === 'OPENCODE_CONFIG_CONTENT' && !isAbsolute(name) && !name.startsWith('~/')) return null;
      const filePath = name.startsWith('~/') ? join(home, name.slice(2)) : resolve(dirname(sourcePath), name);
      const content = normalizeReadText(await readText(filePath));
      if (content.kind !== 'ok') return null;
      expanded += result.slice(offset, reference.index) + content.text.trim();
      offset = reference.index! + reference[0].length;
      if (expanded.length > 16_384) return null;
    }
    expanded += result.slice(offset);
    return expanded.length > 16_384 || /\{(?:env|file):|\$\{/.test(expanded) ? null : nonempty(expanded);
  };
  const sourceFor = (id: string, field: string): string => [...documents].reverse().find(item => has(asObject(asObject(asObject(item.document.value?.provider)?.[id])?.options), field))?.path ?? paths.openCode;
  const connections: RuntimeConnectionConfig[] = [];
  const add = async (id: string, provider: JsonObject, source: ConfigSource, rawBase: unknown, runtime: Runtime | null): Promise<void> => {
    const options = asObject(provider.options), base = await expand(rawBase, sourceFor(id, 'baseURL'));
    const baseURL = parseLocalOrigin(base);
    const rawKey = source === 'environment' ? env.MLX_SCOPE_API_KEY : options?.apiKey;
    const keyDefined = source === 'environment' ? env.MLX_SCOPE_API_KEY !== undefined : has(options, 'apiKey');
    const configuredKey = await expand(rawKey, sourceFor(id, 'apiKey'));
    const saved = asObject(auth.value?.[id]);
    const savedKey = source !== 'environment' && saved?.type === 'api' ? nonempty(saved.key) : null;
    const envNames = Array.isArray(provider.env) ? provider.env.slice(0, 4) : [];
    const providerEnvKey = envNames.flatMap(name => typeof name === 'string' && nonempty(env[name]) ? [nonempty(env[name])!] : [])[0] ?? null;
    const nativeKey = runtime !== 'lmstudio' && runtime !== 'mlx-lm' && runtime !== 'vllm-mlx' && baseURL !== null && nativeOrigin?.origin === baseURL.origin ? nonempty(asObject(native.value?.auth)?.api_key) : null;
    const apiKey = configuredKey ?? savedKey ?? providerEnvKey ?? nativeKey;
    const keyInvalid = apiKey !== null && (apiKey.length > 8192 || /[\r\n\u0000]/.test(apiKey));
    const explicitUnresolved = keyDefined && (typeof rawKey !== 'string' || configuredKey === null);
    const issue: ConfigIssue = !baseURL ? base === null && nonempty(rawBase) ? 'unsupported_config' : 'invalid_endpoint'
      : explicitUnresolved || keyInvalid ? 'unsupported_config'
      : apiKey !== null ? 'none' : authStatus === 'malformed' ? 'malformed_config' : authStatus === 'unreadable' ? 'unreadable_config' : 'missing_credential';
    const model = nonempty(env.MLX_SCOPE_MODEL) ?? nonempty(merged.model);
    const preferredModel = model?.startsWith(`${id}/`) ? model.slice(id.length + 1) : source === 'environment' ? model : null;
    connections.push({ id: safeLabel(id), label: safeLabel(nonempty(provider.name) ?? (source === 'omlx' ? 'oMLX' : id)), runtime: runtime ?? (baseURL && baseURL.origin === nativeOrigin?.origin ? 'omlx' : null),
      config: { baseURL, apiKey: keyInvalid || explicitUnresolved ? null : apiKey, preferredModel, issue, error: issueText(issue), source, configStatus, authStatus } });
  };

  if (envBase) {
    await add('omlx', {}, 'environment', envBase, runtimeValue(env.MLX_SCOPE_RUNTIME) ?? 'omlx');
  } else {
    const entries = Object.entries(providers).sort(([a], [b]) => Number(b === selected) - Number(a === selected) || Number(b === 'omlx') - Number(a === 'omlx'));
    for (const [id, raw] of entries.slice(0, 64)) {
      if (connections.length >= 8) break;
      if (!id || id.length > 120 || /[\u0000-\u001f\u007f]/.test(id)) continue;
      const provider = asObject(raw), options = asObject(provider?.options);
      if (!provider || !has(options, 'baseURL')) continue;
      const base = await expand(options?.baseURL, sourceFor(id, 'baseURL'));
      const hint = hintFor(id, provider.name);
      // Only configured local targets and explicitly named runtime failures enter the chooser.
      if (!parseLocalOrigin(base) && hint === null) continue;
      await add(id, provider, 'opencode', options?.baseURL, hint);
    }
    if (!connections.some(item => item.runtime === 'omlx') && connections.length < 8) {
      const server = asObject(native.value?.server), port = server?.port;
      if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535) {
        const host = nonempty(server?.host) ?? '127.0.0.1';
        await add('omlx', {}, 'omlx', `http://${host === '0.0.0.0' ? '127.0.0.1' : host === '::1' ? '[::1]' : host}:${port}`, 'omlx');
      }
    }
  }
  const issue: ConfigIssue = connections.length ? 'none' : native.status === 'malformed' ? 'malformed_config' : native.status === 'unreadable' ? 'unreadable_config' : 'missing_endpoint';
  return { connections, issue, error: issueText(issue), configStatus, authStatus };
};

/** The oMLX client also supports direct use without the multi-runtime router. */
export const resolveOmlxConfig = async (input: ConfigInput = {}): Promise<OmlxConfig> => {
  const result = await resolveRuntimeConnections(input);
  const selected = result.connections.find(item => item.runtime === 'omlx') ?? result.connections[0];
  return selected?.config ?? { baseURL: null, apiKey: null, preferredModel: null, error: result.error, issue: result.issue, source: null, configStatus: result.configStatus ?? 'missing', authStatus: result.authStatus ?? 'missing' };
};
