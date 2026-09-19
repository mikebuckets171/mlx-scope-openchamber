import { describe, expect, it } from 'bun:test';
import { parseLoopbackOrigin, pathsForHome, resolveOmlxConfig } from './config.ts';

describe('MLX Scope service configuration', () => {
  it('accepts only numeric loopback HTTP origins', () => {
    expect(parseLoopbackOrigin('http://127.0.0.1:8123')?.toString()).toBe('http://127.0.0.1:8123/');
    expect(parseLoopbackOrigin('https://127.0.0.1:8123')).toBeNull();
    expect(parseLoopbackOrigin('http://localhost:8123')).toBeNull();
    expect(parseLoopbackOrigin('http://127.0.0.1:8123?x=1')).toBeNull();
    expect(parseLoopbackOrigin('http://127.0.0.1:8123/path', true)).toBeNull();
    expect(parseLoopbackOrigin('http://user:pass@127.0.0.1:8123')).toBeNull();
    expect(parseLoopbackOrigin('http://127.0.0.1')).toBeNull();
  });

  it('strips a provider /v1 path from the configured endpoint', () => {
    expect(parseLoopbackOrigin('http://127.0.0.1:8123/v1', true)?.toString()).toBe('http://127.0.0.1:8123/');
    expect(parseLoopbackOrigin('http://127.0.0.1:8123/v1')).toBeNull();
  });

  it('reads the existing OpenCode provider and auth files without exposing the key', async () => {
    const home = '/tmp/mlx-scope-test-home';
    const paths = pathsForHome(home, { XDG_CONFIG_HOME: `${home}/config` });
    const files = new Map([
      [paths.openCode, JSON.stringify({
        model: 'omlx/Qwen3.8-27B-Instruct-4bit',
        provider: { omlx: { options: { baseURL: 'http://127.0.0.1:8123/v1' } } },
      })],
      [paths.auth, JSON.stringify({ omlx: { type: 'api', key: 'private-key' } })],
    ]);
    const config = await resolveOmlxConfig({
      env: { XDG_CONFIG_HOME: `${home}/config` },
      home,
      readText: async (path) => files.get(path) ?? null,
    });
    expect(config.baseURL?.toString()).toBe('http://127.0.0.1:8123/');
    expect(config.preferredModel).toBe('Qwen3.8-27B-Instruct-4bit');
    expect(config.apiKey).toBe('private-key');
    expect(config).toMatchObject({ issue: 'none', source: 'opencode', configStatus: 'present', authStatus: 'present' });
  });

  it('uses the native oMLX settings endpoint when OpenCode has no provider URL', async () => {
    const home = '/tmp/mlx-scope-test-home';
    const paths = pathsForHome(home);
    const files = new Map([[paths.omlx, JSON.stringify({ server: { host: '127.0.0.1', port: 8123 } })]]);
    const config = await resolveOmlxConfig({
      env: {},
      home,
      readText: async (path) => files.get(path) ?? null,
    });
    expect(config.baseURL?.toString()).toBe('http://127.0.0.1:8123/');
    expect(config.issue).toBe('missing_credential');
    expect(config.source).toBe('omlx');
  });

  it('supports isolated MLX_SCOPE environment overrides', async () => {
    const config = await resolveOmlxConfig({
      env: {
        MLX_SCOPE_BASE_URL: 'http://127.0.0.1:9123',
        MLX_SCOPE_API_KEY: 'private-key',
        MLX_SCOPE_MODEL: 'Qwen3.8-27B-Instruct-4bit',
      },
      home: '/tmp/mlx-scope-test-home',
      readText: async () => null,
    });
    expect(config.baseURL?.toString()).toBe('http://127.0.0.1:9123/');
    expect(config.apiKey).toBe('private-key');
    expect(config.preferredModel).toBe('Qwen3.8-27B-Instruct-4bit');
    expect(config).toMatchObject({ issue: 'none', configStatus: 'missing', authStatus: 'missing' });
  });

  it('reads JSONC from an explicit OpenCode config and uses the documented data directory', async () => {
    const home = '/tmp/mlx-scope-jsonc-home';
    const dataHome = `${home}/data`;
    const custom = `${home}/custom/opencode.jsonc`;
    const paths = pathsForHome(home, { XDG_DATA_HOME: dataHome });
    const files = new Map<string, string>([
      [custom, '{\n  // local override\n  "model": "omlx/qwen",\n  "provider": { "omlx": { "options": { "baseURL": "http://127.0.0.1:8123/v1", }, }, },\n}'],
      [paths.auth, JSON.stringify({ omlx: { type: 'api', key: 'private-key' } })],
    ]);
    const config = await resolveOmlxConfig({
      env: { OPENCODE_CONFIG: custom, XDG_DATA_HOME: dataHome },
      home,
      readText: async (path) => files.get(path) ?? null,
    });
    expect(config).toMatchObject({
      baseURL: new URL('http://127.0.0.1:8123/'),
      preferredModel: 'qwen',
      apiKey: 'private-key',
      issue: 'none',
      source: 'opencode',
      configStatus: 'present',
      authStatus: 'present',
    });
  });

  it('does not silently fall back after an explicit config is malformed', async () => {
    const home = '/tmp/mlx-scope-malformed-home';
    const paths = pathsForHome(home);
    const custom = `${home}/custom.json`;
    const files = new Map<string, string>([
      [paths.openCode, JSON.stringify({ provider: { omlx: { options: { baseURL: 'http://127.0.0.1:8123' } } } })],
      [custom, '{ "provider": '],
      [paths.auth, JSON.stringify({ omlx: { type: 'api', key: 'private-key' } })],
    ]);
    const config = await resolveOmlxConfig({
      env: { OPENCODE_CONFIG: custom },
      home,
      readText: async (path) => files.get(path) ?? null,
    });
    expect(config).toMatchObject({ baseURL: null, apiKey: 'private-key', issue: 'malformed_config', configStatus: 'malformed' });
  });

  it('distinguishes unreadable and malformed supported files', async () => {
    const home = '/tmp/mlx-scope-status-home';
    const paths = pathsForHome(home);
    const config = await resolveOmlxConfig({
      env: { MLX_SCOPE_API_KEY: 'private-key' },
      home,
      readText: async (path) => path === paths.openCode ? { kind: 'unreadable' } : path === paths.openCodeJSONC ? '{ bad' : null,
    });
    expect(config).toMatchObject({ baseURL: null, issue: 'unreadable_config', configStatus: 'malformed', authStatus: 'missing' });
  });
});


it('uses explicit environment paths and ignores relative XDG roots', () => {
  const expected = '/tmp/scope-home/.config/opencode/opencode.json';
  expect(pathsForHome('/tmp/scope-home', {}).openCode).toBe(expected);
  expect(pathsForHome('/tmp/scope-home', { XDG_CONFIG_HOME: 'relative' }).openCode).toBe(expected);
  expect(pathsForHome('/tmp/scope-home', { XDG_DATA_HOME: 'relative' }).auth).toBe('/tmp/scope-home/.local/share/opencode/auth.json');
});

it('rejects shorthand IPs, encoded authorities and zero ports before URL normalization', () => {
  for (const address of ['127.1','2130706433','0x7f000001','0177.0.0.1','127.0.0.1.','%31%32%37.0.0.1']) {
    expect(parseLoopbackOrigin(`http://${address}:8000/v1`, true)).toBeNull();
  }
  expect(parseLoopbackOrigin('http://127.0.0.1:0')).toBeNull();
  expect(parseLoopbackOrigin('http://127.0.0.1:8000\\v1', true)).toBeNull();
  expect(parseLoopbackOrigin('http://127.0.0.1:8000/v1/../', true)).toBeNull();
});

it('bounds real configuration reads without silently falling back', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const home = await mkdtemp(join(tmpdir(), 'scope-config-'));
  try {
    const paths = pathsForHome(home);
    await mkdir(dirname(paths.openCode), {recursive:true});
    await mkdir(dirname(paths.omlx), {recursive:true});
    await writeFile(paths.omlx, JSON.stringify({server:{host:'127.0.0.1',port:8000}}));
    await writeFile(paths.openCode, JSON.stringify({provider:{omlx:{options:{baseURL:'http://127.0.0.1:8123/v1'}}}}));
    const valid = await resolveOmlxConfig({home, env:{}});
    expect(valid.baseURL?.port).toBe('8123');
    await writeFile(paths.openCode, ' '.repeat(1_000_001));
    const oversized = await resolveOmlxConfig({home, env:{}});
    expect(oversized.baseURL).toBeNull();
    expect(oversized.issue).toBe('unreadable_config');
    await rm(paths.openCode); await mkdir(paths.openCode);
    expect((await resolveOmlxConfig({home, env:{}})).issue).toBe('unreadable_config');
  } finally { await rm(home, {recursive:true,force:true}); }
});

it('explicit HTTP default port remains a valid loopback endpoint', () => {
  expect(parseLoopbackOrigin('http://127.0.0.1:80')?.origin).toBe('http://127.0.0.1');
  expect(parseLoopbackOrigin('http://127.0.0.1:0')).toBeNull();
});


it.skipIf(process.platform === 'win32')('rejects a pipe configuration without waiting for a writer', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const home = await mkdtemp(join(tmpdir(), 'scope-pipe-config-'));
  try {
    const path = join(home, 'config.json');
    const create = spawnSync('mkfifo', [path], {timeout: 2_000, encoding: 'utf8'});
    expect(create.status).toBe(0);
    const input = JSON.stringify({home, env: {OPENCODE_CONFIG: path}});
    const script = `import {resolveOmlxConfig} from ${JSON.stringify(new URL('./config.ts', import.meta.url).href)}; console.log((await resolveOmlxConfig(${input})).issue);`;
    // Isolate the call so a regression cannot leave a blocked filesystem thread in the test runner.
    const read = spawnSync(process.execPath, ['--eval', script], {timeout: 2_000, encoding: 'utf8'});
    expect(read.error).toBeUndefined();
    expect(read.status).toBe(0);
    expect(read.stdout.trim()).toBe('unreadable_config');
  } finally { await rm(home, {recursive: true, force: true}); }
});
