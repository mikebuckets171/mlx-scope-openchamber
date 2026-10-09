import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat, symlink, readdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMediaSetup } from './setup.ts';
import { MediaDiscovery, mediaConfigPath } from './discovery.ts';
import { parseMediaSetup, parseMediaSetupAction } from '../../src/contract/media-setup.ts';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(version = '0.38.0') {
  // Resolve macOS /var's symlink so the installation guard tests real regular paths.
  const { realpath } = await import('node:fs/promises');
  const home = await realpath(await mkdtemp(join(tmpdir(), 'scope-media-setup-'))); roots.push(home);
  const comfy = join(home, 'ComfyUI'), bundle = join(home, 'bundle');
  await mkdir(join(comfy, 'comfy_execution'), { recursive: true }); await mkdir(bundle);
  await writeFile(join(comfy, 'server.py'), '# fixture'); await writeFile(join(comfy, 'comfy_execution', 'progress.py'), '# fixture');
  await writeFile(join(comfy, 'comfyui_version.py'), '__version__ = "' + version + '"');
  await writeFile(join(bundle, '__init__.py'), '# bundled entry'); await writeFile(join(bundle, 'snapshot.py'), '# bundled snapshot');
  let ready = false, calls = 0;
  const fetchImpl = async (input: RequestInfo | URL) => {
    calls++;
    if (String(input).endsWith('/system_stats')) return Response.json({ system: { comfyui_version: version } });
    return ready ? Response.json({ schemaVersion: 1, helperVersion: '1.0.0', comfyVersion: version, supported: true, jobs: [] }) : new Response('', { status: 404 });
  };
  const discovery = new MediaDiscovery({ home, fetchImpl });
  const options = { home, bundleDirectory: bundle, sources: () => discovery.configurations(), invalidate: () => discovery.invalidate(), fetchImpl };
  return { home, comfy, bundle, options, setup: createMediaSetup(options), directory: join(comfy, 'custom_nodes', 'mlx_scope'), ready: () => { ready = true; }, calls: () => calls };
}
test('discovery and readiness are read-only; enable distinguishes installation from live readiness; removal is scoped', async () => {
  const f = await fixture(); const before = await f.setup.status();
  expect(parseMediaSetup(before)).toEqual(before); expect(before.sources[0]?.state).toBe('available');
  expect(await stat(mediaConfigPath(f.home)).catch(() => null)).toBeNull();
  expect(await stat(f.directory).catch(() => null)).toBeNull();
  const installed = await f.setup.action({ action: 'enable', sourceId: 'comfyui' });
  expect(installed.sources[0]?.state).toBe('pending');
  expect((await stat(join(f.directory, 'scope-token'))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(f.directory, 'snapshot.py'), 'utf8')).toBe('# bundled snapshot');
  f.ready(); expect((await f.setup.status()).sources[0]?.state).toBe('ready');
  await f.setup.action({ action: 'disable', sourceId: 'comfyui' });
  expect(await stat(f.directory).catch(() => null)).toBeNull();
  expect(await readFile(join(f.comfy, 'server.py'), 'utf8')).toBe('# fixture');
});
test('conflicting config edits roll back installed helper and preserve the concurrent edit', async () => {
  const f = await fixture();
  const competing = '{"schemaVersion":1,"sources":[],"note":"concurrent edit"}';
  const setup = createMediaSetup({ ...f.options, beforeCommit: async () => { await writeFile(mediaConfigPath(f.home), competing); } });
  await expect(setup.action({ action: 'enable', sourceId: 'comfyui' })).rejects.toThrow('changed during setup');
  expect(await stat(f.directory).catch(() => null)).toBeNull();
  expect(await readFile(mediaConfigPath(f.home), 'utf8')).toBe(competing);
});
test('managed update preserves token; locally edited helper is never overwritten or removed', async () => {
  const f = await fixture(); await f.setup.action({ action: 'enable', sourceId: 'comfyui' });
  const token = await readFile(join(f.directory, 'scope-token'), 'utf8');
  await writeFile(join(f.bundle, 'snapshot.py'), '# next bundle');
  await f.setup.action({ action: 'enable', sourceId: 'comfyui' });
  expect(await readFile(join(f.directory, 'scope-token'), 'utf8')).toBe(token);
  await writeFile(join(f.directory, 'snapshot.py'), '# user edit');
  await expect(f.setup.action({ action: 'enable', sourceId: 'comfyui' })).rejects.toThrow('local changes');
  await expect(f.setup.action({ action: 'disable', sourceId: 'comfyui' })).rejects.toThrow('local changes');
  expect(await readFile(join(f.directory, 'snapshot.py'), 'utf8')).toBe('# user edit');
});
test('unsupported versions retain basic mode and reject installation', async () => {
  const f = await fixture('0.39.0'); expect((await f.setup.status()).sources[0]?.state).toBe('unsupported');
  await expect(f.setup.action({ action: 'enable', sourceId: 'comfyui' })).rejects.toThrow('0.38.0');
  expect(await stat(f.directory).catch(() => null)).toBeNull();
});
test('guided configuration preserves unrelated settings and rejects remote addresses and linked roots', async () => {
  const f = await fixture(); await mkdir(join(f.home, '.config', 'mlx-scope'), { recursive: true });
  await writeFile(mediaConfigPath(f.home), JSON.stringify({ schemaVersion: 1, sources: [], unrelated: { keep: true } }));
  await f.setup.action({ action: 'configure', origin: 'http://127.0.0.1:8190', installationPath: f.comfy, label: 'Studio' });
  expect(JSON.parse(await readFile(mediaConfigPath(f.home), 'utf8')).unrelated).toEqual({ keep: true });
  await expect(f.setup.action({ action: 'configure', origin: 'https://example.com' })).rejects.toThrow('local ComfyUI');
  const link = join(f.home, 'linked'); await symlink(f.comfy, link);
  await expect(f.setup.action({ action: 'configure', origin: 'http://127.0.0.1:8191', installationPath: link })).rejects.toThrow('linked folder');
});
test('multiple discovered installations require a deliberate selection', async () => {
  const f = await fixture(); const other = join(f.home, 'Applications', 'ComfyUI');
  await mkdir(join(other, 'comfy_execution'), { recursive: true });
  await writeFile(join(other, 'server.py'), '# fixture'); await writeFile(join(other, 'comfy_execution', 'progress.py'), '# fixture');
  await writeFile(join(other, 'comfyui_version.py'), '__version__="0.38.0"'); f.options.invalidate();
  const status = await f.setup.status(); expect(status.sources[0]?.locations).toHaveLength(2);
  await expect(f.setup.action({ action: 'enable', sourceId: 'comfyui' })).rejects.toThrow('Choose');
  const result = await f.setup.action({ action: 'enable', sourceId: 'comfyui', locationId: status.sources[0]!.locations[0]!.id });
  expect(result.sources[0]?.state).toBe('pending');
});
test('setup contract rejects excess fields and malformed actions', () => {
  expect(parseMediaSetupAction({ action: 'enable', sourceId: '../root' })).toBeNull();
  expect(parseMediaSetupAction({ action: 'configure', origin: 'http://127.0.0.1:8188', execute: 'anything' })).toBeNull();
  expect(parseMediaSetup({ schemaVersion: 1, sources: Array(9).fill({}) })).toBeNull();
});
test('disabling media persists without probing sources and can be reversed', async () => {
  const f = await fixture();
  const before = f.calls();
  const disabled = await f.setup.action({ action: 'set-enabled', enabled: false });
  expect(disabled.enabled).toBe(false);
  expect(disabled.sources).toEqual([]);
  expect(f.calls()).toBe(before);
  expect((await f.setup.status()).enabled).toBe(false);
  expect(f.calls()).toBe(before);
  const enabled = await f.setup.action({ action: 'set-enabled', enabled: true });
  expect(enabled.enabled).toBe(true);
  expect(enabled.sources[0]?.id).toBe('comfyui');
});
test('a paused source remains discoverable in Connections and can be re-enabled',async()=>{
  const f=await fixture();const paused=await f.setup.action({action:'set-enabled',sourceId:'comfyui',enabled:false});
  expect(paused.sources[0]?.enabled).toBe(false);expect(paused.sources[0]?.id).toBe('comfyui');
  const enabled=await f.setup.action({action:'set-enabled',sourceId:'comfyui',enabled:true});expect(enabled.sources[0]?.state).toBe('available');
});
test('failure to clean an inert backup after commit preserves the new helper and configuration',async()=>{
  const f=await fixture();await f.setup.action({action:'enable',sourceId:'comfyui'});await writeFile(join(f.bundle,'snapshot.py'),'# updated helper');
  const parent=join(f.comfy,'custom_nodes');let backup:string|undefined;
  const setup=createMediaSetup({...f.options,beforeCommit:async()=>{const name=(await readdir(parent)).find(name=>name.startsWith('.mlx-scope-')&&name.endsWith('.disabled'));if(name){backup=join(parent,name);await chmod(backup,0o000);}}});
  try {
    expect((await setup.action({action:'enable',sourceId:'comfyui'})).sources[0]?.state).toBe('pending');
    expect(await readFile(join(f.directory,'snapshot.py'),'utf8')).toBe('# updated helper');
    expect(JSON.parse(await readFile(mediaConfigPath(f.home),'utf8')).sources[0].helperTokenPath).toBe(join(f.directory,'scope-token'));
  } finally {if(backup)await chmod(backup,0o700).catch(()=>{});}
});
test('Connections reports every detected media kind from the shared snapshot without separate network reads',async()=>{
  const f=await fixture();let snapshots=0,network=0;
  const configurations=[{id:'video',kind:'local-video' as const,label:'Local video',directory:'/private/video'},{id:'qwen',kind:'qwen-image' as const,label:'Qwen image',origin:'http://127.0.0.1:9000'},{id:'feed',kind:'feed' as const,label:'Studio',directory:'/private/feed'}];
  const setup=createMediaSetup({...f.options,sources:async()=>configurations,fetchImpl:async()=>{network++;throw new Error('No separate reads');},snapshot:async()=>{snapshots++;return{schemaVersion:1,sampledAtMs:1000,nextPollMs:2000,jobs:[],sources:configurations.map(source=>({id:source.id,kind:source.kind,label:source.label,state:source.id==='qwen'?'unsupported' as const:'ready' as const,capabilities:{progress:false,cancel:false},...(source.id==='qwen'?{message:'This image workflow does not publish media progress yet.'}:{})}))};}});
  const status=await setup.status();expect(status.sources.map(source=>[source.kind,source.state])).toEqual([['local-video','ready'],['qwen-image','unsupported'],['feed','ready']]);
  expect(status.sources.every(source=>!source.canEnable&&!source.canDisable)).toBe(true);expect(status.sources[1]?.message).toContain('does not publish');expect(parseMediaSetup(status)).toEqual(status);expect([snapshots,network]).toEqual([1,0]);
});
