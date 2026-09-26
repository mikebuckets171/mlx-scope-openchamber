import { expect, test } from 'bun:test';
import { parseLocalOrigin, pathsForHome, resolveRuntimeConnections } from './config.ts';

const home = '/tmp/scope-connections';
const paths = pathsForHome(home);
const resolve = (config: unknown, auth: unknown = {}, extra: Record<string, string> = {}, env: NodeJS.ProcessEnv = {}) => {
  const files: Record<string, string> = { [paths.openCode]: JSON.stringify(config), [paths.auth]: JSON.stringify(auth), ...extra };
  return resolveRuntimeConnections({ home, env, readText: async path => files[path] ?? null });
};

test('discovers arbitrary local provider names, prioritizes the selected provider, and excludes cloud targets', async () => {
  const result = await resolve({ model: 'local-work/model-a', provider: {
    omlx: { options: { baseURL: 'http://localhost:8000/v1' } },
    cloud: { options: { baseURL: 'https://api.example.test/v1', apiKey: 'cloud-only-fixture' } },
    'local-work': { name: 'My local engine', options: { baseURL: 'http://[::1]:1234/v1' } },
  } });
  expect(result.connections.map(item => item.id)).toEqual(['local-work', 'omlx']);
  expect(result.connections[0]).toMatchObject({ runtime: null, config: { preferredModel: 'model-a', apiKey: null } });
  expect(result.connections[1]?.config.baseURL?.hostname).toBe('127.0.0.1');
  expect(JSON.stringify(result)).not.toContain('cloud-only-fixture');
});

test('discovers OpenCode 2 providers and reads local endpoints and explicit keys from settings', async () => {
  const result = await resolve({ model: 'local-mlx/model-a', providers: {
    'local-mlx': { name: 'Local vLLM-MLX', env: ['LOCAL_MLX_KEY'], settings: {
      baseURL: 'http://localhost:8000/v1', apiKey: '{env:V2_LOCAL_KEY}',
    } },
    lmstudio: { name: 'LM Studio', settings: { baseURL: 'http://127.0.0.1:1234/v1' } },
    cloud: { settings: { baseURL: 'https://api.example.test/v1', apiKey: 'cloud-only-fixture' } },
  } }, {}, {}, { V2_LOCAL_KEY: 'v2-fixture-key' });

  expect(result.connections.map(item => item.id)).toEqual(['local-mlx', 'lmstudio']);
  expect(result.connections[0]).toMatchObject({ runtime: 'vllm-mlx', config: {
    baseURL: new URL('http://127.0.0.1:8000/'), apiKey: 'v2-fixture-key', preferredModel: 'model-a',
  } });
  expect(result.connections[1]).toMatchObject({ runtime: 'lmstudio', config: { apiKey: null } });
  expect(JSON.stringify(result)).not.toContain('cloud-only-fixture');
});

test('identifies Splash from its exact provider name while leaving unrelated IDs automatic', async () => {
  const result = await resolve({ providers: {
    splash: { name: 'Inco AI Splash', settings: { baseURL: 'http://127.0.0.1:8000/v1' } },
    'splash-proxy': { name: 'Local compatibility proxy', settings: { baseURL: 'http://127.0.0.1:8001/v1' } },
  } });
  expect(result.connections.map(item => item.runtime)).toEqual(['splash', null]);
});

test('native OpenCode 2 provider shape wins over a same-ID legacy provider', async () => {
  const result = await resolve({ model: 'engine/model-a', provider: {
    engine: { name: 'vllm-mlx', options: { baseURL: 'http://localhost:8000/v1' } },
  }, providers: {
    engine: { name: 'LM Studio', settings: { baseURL: 'http://localhost:1234/v1' } },
  } });

  expect(result.connections).toHaveLength(1);
  expect(result.connections[0]).toMatchObject({ id: 'engine', label: 'LM Studio', runtime: 'lmstudio' });
  expect(result.connections[0]?.config.baseURL?.port).toBe('1234');
});

test('OpenCode 2 file references resolve relative to the file defining settings.apiKey', async () => {
  const custom = `${home}/project/custom.jsonc`;
  const result = await resolve({}, {}, {
    [custom]: '{ "providers": { "engine": { "name": "oMLX", "settings": { "baseURL": "{env:V2_LOCAL_URL}", "apiKey": "{file:token.txt}" } } } }',
    [`${home}/project/token.txt`]: '  v2-project-fixture-key\n',
  }, { OPENCODE_CONFIG: custom, V2_LOCAL_URL: 'http://localhost:9876/v1' });

  expect(result.connections[0]).toMatchObject({ runtime: 'omlx', config: { apiKey: 'v2-project-fixture-key', issue: 'none' } });
  expect(result.connections[0]?.config.baseURL?.port).toBe('9876');
});

test('native OpenCode 2 providers do not use stale imported auth.json credentials', async () => {
  const result = await resolve({ providers: {
    omlx: { name: 'oMLX', settings: { baseURL: 'http://localhost:8000/v1' } },
  } }, { omlx: { type: 'api', key: 'stale-v1-fixture-key' } });

  expect(result.connections[0]).toMatchObject({ config: { apiKey: null, issue: 'missing_credential' } });
  expect(JSON.stringify(result)).not.toContain('stale-v1-fixture-key');
});

test('OpenCode 2 config directory is the sole global provider root when available', async () => {
  const customDir = `${home}/isolated-opencode`;
  const customPaths = pathsForHome(home, { OPENCODE_CONFIG_DIR: customDir });
  const files: Record<string, string> = {
    [paths.openCode]: JSON.stringify({ providers: {
      inactive: { name: 'oMLX', settings: { baseURL: 'http://localhost:8001/v1' } },
    } }),
    [`${customDir}/config.json`]: JSON.stringify({ provider: {
      legacy: { name: 'oMLX', options: { baseURL: 'http://localhost:8002/v1' } },
    } }),
    [customPaths.openCode]: JSON.stringify({ providers: {
      active: { name: 'vllm-mlx', settings: { baseURL: 'http://localhost:8003/v1' } },
    } }),
    [customPaths.openCodeJSONC]: '{ "providers": { "active": { "settings": { "apiKey": "{file:token.txt}" } } } }',
    [`${customDir}/token.txt`]: 'custom-dir-fixture-key',
    [paths.auth]: '{}',
  };
  const result = await resolveRuntimeConnections({
    home,
    env: { OPENCODE_CONFIG_DIR: customDir },
    readText: async path => files[path] ?? null,
  });

  expect(customPaths.openCode).toBe(`${customDir}/opencode.json`);
  expect(result.connections.map(item => item.id)).toEqual(['active']);
  expect(result.connections[0]).toMatchObject({ runtime: 'vllm-mlx', config: {
    baseURL: new URL('http://127.0.0.1:8003/'), apiKey: 'custom-dir-fixture-key', issue: 'none',
  } });
});

test('relative OpenCode 2 config directory fails visibly instead of reading the default root', async () => {
  const result = await resolve({ provider: {
    active: { name: 'oMLX', options: { baseURL: 'http://localhost:8000/v1' } },
  } }, {}, {}, { OPENCODE_CONFIG_DIR: 'relative-config' });

  expect(result).toMatchObject({ connections: [], issue: 'unsupported_config' });
});

test('unrelated auth file failures do not mislabel OpenCode 2 or explicit environment credentials', async () => {
  for (const authFailure of [
    { kind: 'ok' as const, text: '{ malformed' },
    { kind: 'unreadable' as const },
  ]) {
    const v2 = await resolveRuntimeConnections({
      home,
      env: {},
      readText: async path => path === paths.openCode
        ? JSON.stringify({ providers: { omlx: { settings: { baseURL: 'http://localhost:8000/v1' } } } })
        : path === paths.auth ? authFailure : null,
    });
    expect(v2.connections[0]?.config).toMatchObject({ issue: 'missing_credential', apiKey: null });
    expect(v2.authStatus).toBe(authFailure.kind === 'ok' ? 'malformed' : 'unreadable');

    const explicit = await resolveRuntimeConnections({
      home,
      env: { MLX_SCOPE_BASE_URL: 'http://localhost:8000/v1', MLX_SCOPE_RUNTIME: 'omlx' },
      readText: async path => path === paths.auth ? authFailure : null,
    });
    expect(explicit.connections[0]?.config).toMatchObject({ issue: 'missing_credential', apiKey: null });
  }
});

test('keeps credentials tied to provider identity with explicit key precedence', async () => {
  const provider = Object.fromEntries(['a', 'b', 'c'].map((id, index) => [id, {
    env: ['LOCAL_ENGINE_KEY'], options: { baseURL: `http://127.0.0.1:${8000 + index}/v1`, ...(id === 'a' ? { apiKey: '{env:EXPLICIT_KEY}' } : {}) },
  }]));
  const result = await resolve({ provider }, { a: { type: 'api', key: 'saved-a' }, b: { type: 'api', key: 'saved-b' }, c: { type: 'oauth', access: 'oauth-not-api' } }, {}, { EXPLICIT_KEY: 'explicit-a', LOCAL_ENGINE_KEY: 'env-c' });
  expect(result.connections.map(item => item.config.apiKey)).toEqual(['explicit-a', 'saved-b', 'env-c']);
});

test('resolves JSONC overlays and file references relative to the file that defines each field', async () => {
  const custom = `${home}/project/custom.jsonc`;
  const result = await resolve({ provider: { engine: { options: { baseURL: '{env:LOCAL_URL}', apiKey: '{file:key.txt}' } } } }, {}, {
    [custom]: '{ // a provider overlay\n "provider": { "engine": { "options": { "apiKey": "{file:token.txt}", }, }, }, }',
    [`${home}/project/token.txt`]: '  project-fixture-key\n',
  }, { OPENCODE_CONFIG: custom, LOCAL_URL: 'http://localhost:9876/v1' });
  expect(result.connections[0]?.config).toMatchObject({ apiKey: 'project-fixture-key', issue: 'none' });
  expect(result.connections[0]?.config.baseURL?.port).toBe('9876');
});

test('an unresolved explicit key cannot silently fall back to a saved key or anonymous access', async () => {
  for (const apiKey of ['{env:NOT_DEFINED}', '{file:missing.txt}', 'invalid\nheader']) {
    const result = await resolve({ provider: { omlx: { options: { baseURL: 'http://localhost:8000/v1', apiKey } } } }, { omlx: { type: 'api', key: 'fallback-fixture' } });
    expect(result.connections[0]?.config).toMatchObject({ issue: 'unsupported_config', apiKey: null });
  }
});

test('native oMLX credentials apply only to its exact configured origin', async () => {
  const native = JSON.stringify({ server: { host: '0.0.0.0', port: 8000 }, auth: { api_key: 'native-fixture' } });
  const result = await resolve({ provider: {
    first: { options: { baseURL: 'http://localhost:8000/v1' } },
    second: { options: { baseURL: 'http://127.0.0.1:8001/v1' } },
  } }, {}, { [paths.omlx]: native });
  expect(result.connections).toHaveLength(2);
  expect(result.connections[0]).toMatchObject({ runtime: 'omlx', config: { apiKey: 'native-fixture' } });
  expect(result.connections[1]).toMatchObject({ runtime: null, config: { apiKey: null } });
});

test('retains actionable known-runtime URL failures without probing remote servers', async () => {
  const result = await resolve({ provider: {
    lmstudio: { options: { baseURL: 'https://example.test/v1' } },
    unrelated: { options: { baseURL: 'https://other.test/v1' } },
  } });
  expect(result.connections).toHaveLength(1);
  expect(result.connections[0]?.config).toMatchObject({ baseURL: null, issue: 'invalid_endpoint' });
});

test('bounds discovered connections and rejects identifiers that cannot round-trip', async () => {
  const provider = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`local-${index}`, { options: { baseURL: `http://127.0.0.1:${8000 + index}` } }]));
  provider['bad\nname'] = { options: { baseURL: 'http://localhost:9000' } };
  const result = await resolve({ model: 'local-19/model', provider });
  expect(result.connections).toHaveLength(8);
  expect(result.connections[0]?.id).toBe('local-19');
  expect(result.connections.every(item => !item.id.includes('\n'))).toBe(true);
});

test('rejects normalized, remote, credential-bearing, and path-bearing URL tricks', () => {
  for (const value of ['http://127.1:8000', 'http://2130706433:8000', 'http://localhost.example.test:8000', 'http://user:password@localhost:8000', 'http://localhost:8000/v1/../', 'http://localhost:8000?x=1', 'http://[::2]:8000', 'http://localhost:65536', 'http://localhost:0']) expect(parseLocalOrigin(value)).toBeNull();
});

test('an explicit environment target never borrows the named oMLX provider credential', async () => {
  for (const runtime of ['lmstudio', 'mlx-lm', 'vllm-mlx', 'omlx']) {
    const result = await resolve({}, { omlx: { type: 'api', key: 'unrelated-saved-fixture' } }, {},
      { MLX_SCOPE_BASE_URL: 'http://localhost:1234/v1', MLX_SCOPE_RUNTIME: runtime });
    expect(result.connections[0]?.config.apiKey).toBeNull();
  }
});

test('inline OpenCode configuration and auth take precedence without executing the CLI', async () => {
  const result = await resolve({ provider: { studio: { options: { baseURL: 'http://localhost:1234/v1' } } } }, { studio: { type: 'api', key: 'old-fixture' } }, {}, {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { studio: { name: 'LM Studio', options: { baseURL: 'http://localhost:2345/v1' } } } }),
    OPENCODE_AUTH_CONTENT: JSON.stringify({ studio: { type: 'api', key: 'current-fixture' } }),
  });
  expect(result.connections[0]).toMatchObject({ runtime: 'lmstudio', config: { apiKey: 'current-fixture' } });
  expect(result.connections[0]?.config.baseURL?.port).toBe('2345');
});

test('invalid inline auth and ambiguous relative inline file references fail visibly', async () => {
  const config = { provider: { omlx: { options: { baseURL: 'http://localhost:8000/v1' } } } };
  const broken = await resolve(config, { omlx: { type: 'api', key: 'stale-fixture' } }, {}, { OPENCODE_AUTH_CONTENT: '{ bad' });
  expect(broken.connections[0]?.config).toMatchObject({ issue: 'malformed_config', apiKey: null });
  const relative = await resolve(config, {}, {}, { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { omlx: { options: { apiKey: '{file:relative.key}' } } } }) });
  expect(relative.connections[0]?.config.issue).toBe('unsupported_config');
});

test('file references expand after environment references and never become literal credentials', async () => {
  const extra = { [`${home}/.config/opencode/token.txt`]: 'fixture-value' };
  for (const apiKey of ['prefix-{file:token.txt}', 'prefix-{file:{env:TOKEN_FILE}}']) {
    const result = await resolve({ provider: { omlx: { options: { baseURL: 'http://localhost:8000', apiKey } } } }, {}, extra, { TOKEN_FILE: 'token.txt' });
    expect(result.connections[0]?.config).toMatchObject({ issue: 'none', apiKey: 'prefix-fixture-value' });
  }
  for (const apiKey of ['{file:missing.txt}-suffix', '{file:{env:UNDEFINED}}', 123, {}, null, '']) {
    const result = await resolve({ provider: { omlx: { options: { baseURL: 'http://localhost:8000', apiKey } } } }, { omlx: { type: 'api', key: 'fallback-fixture' } });
    expect(result.connections[0]?.config).toMatchObject({ issue: 'unsupported_config', apiKey: null });
  }
});

test('native IPv6 loopback settings retain the correct origin and matching key', async () => {
  const result = await resolve({}, {}, { [paths.omlx]: JSON.stringify({ server: { host: '::1', port: 8000 }, auth: { api_key: 'native-fixture' } }) });
  expect(result.connections[0]?.config.baseURL?.href).toBe('http://[::1]:8000/');
  expect(result.connections[0]?.config.apiKey).toBe('native-fixture');
});
