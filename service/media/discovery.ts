import { join, isAbsolute } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser/lib/esm/main.js';
import { chatKey } from '../../src/contract/chat-key.ts';
import { obj, label } from '../../src/contract/guards.ts';
import { mediaId, MEDIA_SOURCE_LIMIT, type MediaSourceV1 } from '../../src/contract/media.ts';
import { requestJSON, type FetchImplementation } from '../http.ts';
import { pathsForHome } from '../config.ts';
import { directoryExists, readBounded } from './files.ts';

/** Private service configuration. Paths, origins and credentials never enter a MediaSnapshotV1. */
export interface MediaSourceConfig {
  id: string;
  kind: MediaSourceV1['kind'];
  label: string;
  origin?: string;
  installationPath?: string;
  directory?: string;
  tokenPath?: string;
  helperTokenPath?: string;
  version?: string;
}
export const mediaConfigPath = (home: string): string => join(home, '.config/mlx-scope/media.json');
export const localOrigin = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' ? url.origin : null;
  } catch { return null; }
};
const absolute = (raw: unknown): string | undefined => typeof raw === 'string' && raw.length < 4096 && !/[\u0000-\u001f]/.test(raw) && isAbsolute(raw) ? raw : undefined;
export class MediaDiscovery {
  enabled = true;
  private cached: MediaSourceConfig[] = [];
  private until = 0;
  private flight: Promise<MediaSourceConfig[]> | null = null;
  constructor(private options: { home: string; fetchImpl?: FetchImplementation; now?: () => number; env?: NodeJS.ProcessEnv }) {}
  invalidate(enabled?: boolean): void { this.until = 0; if (enabled !== undefined) this.enabled = enabled; }
  configurations(): Promise<MediaSourceConfig[]> {
    const now = this.options.now?.() ?? Date.now();
    if (this.flight) return this.flight;
    if (now < this.until) return Promise.resolve(this.cached);
    this.flight = this.discover().then(sources => { this.cached = sources; this.until = now + 30_000; return sources; }).finally(() => { this.flight = null; });
    return this.flight;
  }
  private async discover(): Promise<MediaSourceConfig[]> {
    const home = this.options.home, sources: MediaSourceConfig[] = [], disabled = new Set<string>(), disabledOrigins = new Set<string>(), disabledDirectories = new Set<string>();
    this.enabled = true;
    const file = await readBounded(mediaConfigPath(home), 64_000);
    if (file) {
      let config; try { config = obj(JSON.parse(file.text)); } catch { return []; }
      if (!config || config.schemaVersion !== 1 || config.enabled === false) { this.enabled = false; return []; }
      for (const raw of Array.isArray(config.sources) ? config.sources.slice(0, MEDIA_SOURCE_LIMIT) : []) {
        const source = obj(raw), id = mediaId(source?.id), kind = source?.kind;
        if (!source || !id || !['comfyui', 'local-video', 'qwen-image', 'feed'].includes(String(kind))) continue;
        const origin = localOrigin(source.origin), directory = absolute(source.directory);
        if (source.enabled === false) { disabled.add(id); if (origin) disabledOrigins.add(origin); if (directory) disabledDirectories.add(directory); continue; }
        if ((kind === 'comfyui' || kind === 'qwen-image') && !origin || (kind === 'feed' || kind === 'local-video') && !directory) continue;
        sources.push({ id, kind: kind as MediaSourceV1['kind'], label: label(source.label, 80) ?? (kind === 'comfyui' ? 'ComfyUI' : kind === 'local-video' ? 'Local video' : kind === 'qwen-image' ? 'Qwen image' : 'Media feed'),
          ...origin ? { origin } : {}, ...directory ? { directory } : {}, installationPath: absolute(source.installationPath), tokenPath: absolute(source.tokenPath), helperTokenPath: absolute(source.helperTokenPath) });
      }
    }
    const add = (source: MediaSourceConfig): void => { if (sources.length < MEDIA_SOURCE_LIMIT && !disabled.has(source.id) && !(source.origin && disabledOrigins.has(source.origin)) && !(source.directory && disabledDirectories.has(source.directory)) && !sources.some(item => item.id === source.id || source.origin && item.origin === source.origin || source.directory && item.directory === source.directory)) sources.push(source); };
    for (const source of await configuredMediaSources(home, this.options.env ?? {})) add(source);
    const video = join(home, '.config/opencode/state/video-queue');
    if (await directoryExists(video)) add({ id: 'local-video', kind: 'local-video', label: 'Local video', directory: video });
    const feed = join(home, '.config/mlx-scope/media-feeds');
    if (await directoryExists(feed)) add({ id: 'media-feed', kind: 'feed', label: 'Media feed', directory: feed });
    if (!disabled.has('comfyui') && !sources.some(source => source.kind === 'comfyui')) {
      const installations = [join(home, 'ComfyUI'), join(home, 'Applications/ComfyUI')];
      const found: string[] = [];
      for (const directory of installations) if (await readBounded(join(directory, 'comfyui_version.py'), 4096)
        && await readBounded(join(directory, 'server.py'), 512_000) && await directoryExists(join(directory, 'comfy_execution'))) found.push(directory);
      const origin = 'http://127.0.0.1:8188';
      let version: string | undefined;
      try { const result = await requestJSON({ url: new URL('/system_stats', origin), fetchImpl: this.options.fetchImpl ?? fetch, timeoutMs: 800 }); version = label(obj(result.body?.system)?.comfyui_version, 40) ?? undefined; } catch { /* a passive probe never starts ComfyUI */ }
      if (version || found.length) add({ id: 'comfyui', kind: 'comfyui', label: 'ComfyUI', origin, version, ...found.length === 1 ? { installationPath: found[0] } : {} });
    }
    return sources;
  }
}

/** Only recognize explicit launch metadata or named Qwen/Comfy integrations; never invoke an MCP tool. */
export const configuredMediaSources = async (home: string, env: NodeJS.ProcessEnv = {}): Promise<MediaSourceConfig[]> => {
  const paths = pathsForHome(home, env), servers = new Map<string, Record<string, unknown>>();
  for (const file of [paths.openCode, paths.openCodeJSONC]) {
    const content = await readBounded(file, 1_000_000); if (!content) continue;
    const errors: ParseError[] = [], root = obj(parse(content.text, errors, { allowTrailingComma: true }));
    if (errors.length || !root) continue;
    const mcp = obj(root.mcp), entries = obj(mcp?.servers) ?? mcp;
    for (const [name, raw] of Object.entries(entries ?? {}).slice(0, 64)) { const item = obj(raw); if (item) servers.set(name, item); }
  }
  const sources: MediaSourceConfig[] = [];
  const path = (raw: unknown): string | undefined => typeof raw === 'string' ? absolute(raw.startsWith('~/') ? join(home, raw.slice(2)) : raw) : undefined;
  for (const [name, item] of servers) {
    if (sources.length >= MEDIA_SOURCE_LIMIT) break;
    if (item.enabled === false) continue;
    const environment = obj(item.environment) ?? obj(item.env) ?? {}, command = Array.isArray(item.command) ? item.command.filter((item): item is string => typeof item === 'string').slice(0, 32) : [];
    const qwen = /(?:^|[\W_])qwen[\W_]?(?:image)/i.test(name) || command.some(arg => /(?:^|\/)qwen_image_(?:http|mcp)\.py$/.test(arg));
    const comfy = /comfyui/i.test(name) || path(environment.COMFYUI_DIR) !== undefined;
    if (!qwen && !comfy) continue;
    let origin: string | null = null;
    try {
      if (typeof item.url === 'string') { const url = new URL(item.url); if (!url.username && !url.password && !url.search && !url.hash) origin = localOrigin(url.origin); }
    } catch { /* invalid endpoint */ }
    const index = command.indexOf('--port'), port = index >= 0 ? Number(command[index + 1]) : undefined;
    const hostIndex = command.indexOf('--host'), host = hostIndex >= 0 ? command[hostIndex + 1] : '127.0.0.1';
    if (!origin && port && Number.isInteger(port) && port > 0 && port < 65536) origin = localOrigin(`http://${host === '::1' ? '[::1]' : host}:${port}`);
    const rawAuthorization = obj(item.headers)?.Authorization ?? obj(item.headers)?.authorization;
    const fileReference = typeof rawAuthorization === 'string' ? /^Bearer\s+\{file:([^}]+)\}$/.exec(rawAuthorization) : null;
    const tokenPath = path(environment.MCP_BEARER_TOKEN_FILE) ?? path(fileReference?.[1]);
    const key = chatKey('provider', name).slice(0, 8);
    if (qwen && origin && tokenPath) sources.push({ id: `qwen-image-${key}`, kind: 'qwen-image', label: 'Qwen image', origin, tokenPath });
    const installationPath = path(environment.COMFYUI_DIR) ?? (path(environment.QWEN_IMAGE_APP_ROOT) ? join(path(environment.QWEN_IMAGE_APP_ROOT)!, 'ComfyUI') : undefined);
    const comfyPort = Number(environment.QWEN_IMAGE_COMFY_PORT ?? environment.COMFY_PORT ?? 8188), comfyHost = environment.QWEN_IMAGE_COMFY_HOST ?? '127.0.0.1';
    const comfyOrigin = localOrigin(`http://${comfyHost === '::1' ? '[::1]' : comfyHost}:${comfyPort}`);
    if (installationPath && comfyOrigin && Number.isInteger(comfyPort) && comfyPort > 0 && comfyPort < 65536 && sources.length < MEDIA_SOURCE_LIMIT)
      sources.push({ id: `comfyui-${key}`, kind: 'comfyui', label: 'ComfyUI', origin: comfyOrigin, installationPath });
    else if (comfy && origin && sources.length < MEDIA_SOURCE_LIMIT) sources.push({ id: `comfyui-${key}`, kind: 'comfyui', label: 'ComfyUI', origin, tokenPath });
  }
  return sources;
};
