import { parse, type ParseError } from 'jsonc-parser/lib/esm/main.js';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

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

type ConfigInput = {
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

/**
 * Keep the plugin's loopback-origin contract. The returned URL
 * is always an origin with a trailing slash; no configured path is retained.
 */
export const parseLoopbackOrigin = (value: unknown, stripPath = false): URL | null => {
  const candidate = nonempty(value);
  if (candidate === null || !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}(?:\/v1\/?)?\/?$/.test(candidate)) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '0') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '' && url.pathname !== '/' && (!stripPath || !['/v1', '/v1/'].includes(url.pathname))) return null;
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
};

const providerOptions = (config: JsonObject | null): JsonObject | null => {
  const providers = asObject(config?.provider);
  const omlx = asObject(providers?.omlx);
  return asObject(omlx?.options);
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

const selectedOmlxModel = (config: JsonObject | null, env: NodeJS.ProcessEnv): string | null => {
  const configured = nonempty(env.MLX_SCOPE_MODEL);
  const model = configured ?? nonempty(config?.model);
  if (model === null) return null;
  const [provider, ...rest] = model.split('/');
  if (configured !== null) return provider === 'omlx' && rest.length > 0 ? rest.join('/') : configured;
  return provider === 'omlx' && rest.length > 0 ? rest.join('/') : null;
};

const nativeEndpoint = (settings: JsonObject | null): string | null => {
  const server = asObject(settings?.server);
  const host = nonempty(server?.host) ?? '127.0.0.1';
  const port = typeof server?.port === 'number' && Number.isInteger(server.port)
    ? server.port
    : null;
  return port !== null && port >= 1 && port <= 65_535 ? `http://${host}:${port}` : null;
};

/** Resolve the local OpenCode and oMLX configuration files used by the plugin. */
export const resolveOmlxConfig = async ({ env = process.env, home = env.HOME ?? homedir(), readText = defaultReadText }: ConfigInput = {}): Promise<OmlxConfig> => {
  const paths = pathsForHome(home, env);
  const configOverride = nonempty(env.OPENCODE_CONFIG);
  const unsupportedOverride = configOverride !== null && !isAbsolute(configOverride);
  const configFiles = [
    await readJson(paths.openCode, readText),
    await readJson(paths.openCodeJSONC, readText),
  ];
  if (configOverride !== null && !unsupportedOverride) configFiles.push(await readJson(configOverride, readText));
  const omlx = await readJson(paths.omlx, readText);
  const auth = await readJson(paths.auth, readText);

  const configProblem = configFiles.find((document) => document.status === 'unreadable' || document.status === 'malformed');
  const mergedOpenCode = configProblem === undefined
    ? configFiles.filter((document): document is Document & { status: 'ok'; value: JsonObject } => document.status === 'ok')
      .reduce<JsonObject>((result, document) => merge(result, document.value), {})
    : null;
  const options = providerOptions(mergedOpenCode);
  const providerHasBase = has(options, 'baseURL');
  const providerBase = providerHasBase ? options?.baseURL : undefined;
  const envBase = nonempty(env.MLX_SCOPE_BASE_URL);
  const nativeCandidate = nativeEndpoint(omlx.value);
  const nativeProblem = omlx.status === 'unreadable' || omlx.status === 'malformed' ? omlx.status : null;
  const configStatus = statusOf(configFiles);
  const authStatus = statusOf([auth]);
  const endpointSource: ConfigSource = envBase !== null ? 'environment' : providerHasBase ? 'opencode' : nativeCandidate !== null ? 'omlx' : null;
  const sourceProblem: ConfigIssue = unsupportedOverride
    ? 'unsupported_config'
    : configProblem?.status === 'unreadable'
      ? 'unreadable_config'
      : configProblem?.status === 'malformed'
        ? 'malformed_config'
        : envBase !== null || providerHasBase
          ? 'none'
          : nativeProblem === 'unreadable'
            ? 'unreadable_config'
            : nativeProblem === 'malformed'
              ? 'malformed_config'
              : 'none';
  const endpointCandidate = envBase ?? (typeof providerBase === 'string' ? providerBase : providerHasBase ? null : nativeCandidate);
  const baseURL = sourceProblem !== 'none' && envBase === null
    ? null
    : parseLoopbackOrigin(endpointCandidate, envBase === null && providerHasBase && typeof providerBase === 'string');
  const endpointIssue: ConfigIssue = sourceProblem !== 'none' && envBase === null
    ? sourceProblem
    : endpointCandidate === null
      ? providerHasBase ? 'invalid_endpoint' : 'missing_endpoint'
      : baseURL === null
        ? 'invalid_endpoint'
        : 'none';

  const envKey = nonempty(env.MLX_SCOPE_API_KEY);
  const authProvider = asObject(asObject(auth.value)?.omlx);
  const authKey = authProvider?.type === 'api' ? nonempty(authProvider.key) : null;
  const credentialIssue: ConfigIssue = envKey !== null || authKey !== null
    ? 'none'
    : auth.status === 'unreadable'
      ? 'unreadable_config'
      : auth.status === 'malformed'
        ? 'malformed_config'
        : 'missing_credential';
  const issue = endpointIssue !== 'none' ? endpointIssue : credentialIssue;
  const error = issue === 'missing_endpoint'
    ? 'No oMLX endpoint was found in OpenCode or oMLX configuration.'
    : issue === 'invalid_endpoint'
      ? 'The saved oMLX endpoint is not a numeric loopback HTTP origin.'
      : issue === 'missing_credential'
        ? 'No oMLX API credential was found in OpenCode auth.'
        : issue === 'malformed_config'
          ? 'A supported oMLX configuration file is malformed.'
          : issue === 'unreadable_config'
            ? 'A supported oMLX configuration file could not be read.'
            : issue === 'unsupported_config'
              ? 'OPENCODE_CONFIG must be an absolute path when supplied to the service.'
              : null;

  return {
    baseURL,
    apiKey: envKey ?? authKey,
    preferredModel: selectedOmlxModel(mergedOpenCode, env),
    error,
    issue,
    source: baseURL === null ? null : endpointSource,
    configStatus,
    authStatus,
  };
};

export const __test__ = {
  asObject,
  nativeEndpoint,
  providerOptions,
  selectedOmlxModel,
  nonempty,
};
