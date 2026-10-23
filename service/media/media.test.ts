import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { comfyUI, type MediaAdapterOptions } from './adapters.ts';
import { MediaDiscovery, localOrigin, mediaConfigPath, configuredMediaSources, type MediaSourceConfig } from './discovery.ts';
import { MediaService } from './service.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const temp = async (): Promise<string> => { const directory = await mkdtemp(join(tmpdir(), 'scope-media-')); directories.push(directory); return directory; };
const NOW = 1_791_500_000_000;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const options = (fetchImpl: MediaAdapterOptions['fetchImpl']): MediaAdapterOptions => ({ now: () => NOW, fetchImpl });
const COMFY: MediaSourceConfig = { id: 'comfy', kind: 'comfyui', label: 'ComfyUI', origin: 'http://127.0.0.1:8188', version: '0.38.0' };
const helper = (observedAtMs: number, jobs: unknown[]) => json({ schemaVersion: 1, helperVersion: '1.0.0', comfyVersion: '0.38.0', supported: true, observedAtMs, jobs });
test('discovery is read-only, shared, finite, and fully disabled by explicit configuration', async () => {
  const home = await temp(); let calls = 0;
  const discovery = new MediaDiscovery({ home, now: () => NOW, fetchImpl: async url => { if (String(url).endsWith('/system_stats')) calls++; return json({ system: { comfyui_version: '0.38.0' } }); } });
  const [a,b] = await Promise.all([discovery.configurations(), discovery.configurations()]);
  expect(a).toEqual(b); expect(a[0]?.origin).toBe('http://127.0.0.1:8188'); expect(calls).toBe(1);
  await mkdir(join(home, '.config/mlx-scope'), { recursive: true });
  await writeFile(mediaConfigPath(home), JSON.stringify({ schemaVersion: 1, enabled: false }));
  discovery.invalidate(); expect(await discovery.configurations()).toEqual([]); expect(calls).toBe(1);
  for (const invalid of ['http://example.com', 'http://localhost.evil', 'file:///etc/passwd', 'http://user:pass@localhost', 'http://localhost/foo']) expect(localOrigin(invalid)).toBeNull();
});
test('ComfyUI lifecycle works without helper and queue fallback stays indeterminate', async () => {
  const out = await comfyUI(COMFY, options(async input => String(input).includes('/api/jobs') ? json({},404) : json({queue_running:[[0,'prompt1', {private:'prompt'}, {},[]]],queue_pending:[]})));
  expect(out.jobs[0]?.state).toBe('running'); expect(out.jobs[0]?.progress).toBeNull(); expect(out.jobs[0]?.cancel.supported).toBe(false);
});
test('ComfyUI helper only applies measured counters to the exact running prompt', async () => {
  const directory = await temp(), tokenPath=join(directory,'token'); await writeFile(tokenPath,'a'.repeat(32),{mode:0o600});
  let value=0,total=1, promptId='prompt1';
  const opts=options(async input=>String(input).includes('/api/jobs')?json({jobs:[{id:'prompt1',status:'in_progress'}]}):helper(NOW,[{promptId,phase:'sampling',progress:{value,total,unit:'steps'}}]));
  const config={...COMFY,helperTokenPath:tokenPath};
  expect((await comfyUI(config,opts)).jobs[0]?.progress).toBeNull(); value=2;total=10;
  expect((await comfyUI(config,opts)).jobs[0]?.progress?.value).toBe(2); promptId='other';
  expect((await comfyUI(config,opts)).jobs[0]?.progress).toBeNull();
});
test('shared collection coalesces visible reads, has no background requests, preserves progress-change time, and withdraws disconnected values',async()=>{
  let now=NOW,calls=0,offline=false,value=1;
  const directory=await temp(), tokenPath=join(directory,'token');await writeFile(tokenPath,'a'.repeat(32),{mode:0o600});
  const service=new MediaService({home:directory,now:()=>now,configurations:async()=>[{...COMFY,helperTokenPath:tokenPath}],fetchImpl:async input=>{calls++;if(offline)throw new Error('offline');return String(input).includes('/api/jobs')?json({jobs:[{id:'job',status:'in_progress'}]}):helper(now,[{promptId:'job',phase:'sampling',progress:{value,total:10,unit:'steps'}}]);}});
  expect(calls).toBe(0);const [a,b]=await Promise.all([service.snapshot(),service.snapshot()]);expect(calls).toBe(2);expect(a).toEqual(b);
  now+=2000;expect((await service.snapshot()).jobs[0]?.progressAtMs).toBe(NOW);value=2;now+=2000;expect((await service.snapshot()).jobs[0]?.progressAtMs).toBe(now);
  offline=true;now+=2000;const failed=await service.snapshot();expect(failed.jobs[0]?.progress).toBeNull();expect(failed.jobs[0]?.freshness).toBe('unavailable');expect(failed.sources[0]?.state).toBe('disconnected');
});
test('cancellation validates current job, coalesces requests and waits for terminal acknowledgement',async()=>{
  let now=NOW,cancels=0,status='in_progress';
  const service=new MediaService({home:await temp(),now:()=>now,configurations:async()=>[COMFY],fetchImpl:async(input,init)=>{if(init?.method==='POST'){cancels++;expect(String(input)).toEndWith('/api/jobs/job/cancel');return json({cancelled:true});}return json({jobs:[{id:'job',status}]});}});
  const [a,b]=await Promise.all([service.cancel('comfy','job'),service.cancel('comfy','job')]);expect(a.status).toBe('requested');expect(a).toEqual(b);expect(cancels).toBe(1);
  expect((await service.snapshot()).jobs[0]?.state).toBe('cancelling');status='cancelled';now+=2000;expect((await service.snapshot()).jobs[0]?.state).toBe('cancelled');
  expect((await service.cancel('comfy','job')).status).toBe('conflict');expect((await service.cancel('comfy','missing')).status).toBe('not-found');expect(cancels).toBe(1);
});
test('source endpoint changes discard cached readings immediately',async()=>{
  let origin='http://127.0.0.1:8188';
  const service=new MediaService({home:await temp(),now:()=>NOW,configurations:async()=>[{...COMFY,origin}],fetchImpl:async input=>json({jobs:[{id:String(input).includes(':8188')?'old-job':'new-job',status:'in_progress'}]})});
  expect((await service.snapshot()).jobs[0]?.id).toBe('old-job');origin='http://127.0.0.1:8189';
  service.invalidate();
  expect((await service.snapshot()).jobs[0]?.id).toBe('new-job');
});
test('OpenCode discovery reads JSONC metadata without probing tools, exposing credentials or discovering unrelated MCP servers',async()=>{
  const home=await temp(),directory=join(home,'.config/opencode');await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'opencode.jsonc'),`{ // existing comments remain untouched
    "mcp":{"servers":{
      "comfyui":{"type":"local","command":["python","main.py"],"environment":{"COMFYUI_DIR":"${home}/ComfyUI","COMFY_PORT":"8190"}},
      "comfyui-remote":{"type":"remote","url":"http://127.0.0.1:9000/mcp","headers":{"Authorization":"Bearer {file:~/private/token}"}},
      "unrelated":{"type":"remote","url":"http://127.0.0.1:9999/mcp","headers":{"Authorization":"Bearer private-secret"}},
      "comfyui-disabled":{"enabled":false,"url":"http://127.0.0.1:9001/mcp","headers":{"Authorization":"Bearer {file:~/private/token}"}}
    }}}
  `);
  const sources=await configuredMediaSources(home);expect(sources).toHaveLength(2);
  expect(sources[0]?.kind).toBe('comfyui');expect(sources[0]?.origin).toBe('http://127.0.0.1:8190');
  expect(sources[1]?.origin).toBe('http://127.0.0.1:9000');expect(sources[1]?.tokenPath).toBe(join(home,'private/token'));
  expect(JSON.stringify(sources)).not.toContain('private-secret');
});
test('disabled sources cannot be rediscovered under another automatic id',async()=>{
  const home=await temp();await mkdir(join(home,'.config/opencode'),{recursive:true});await mkdir(join(home,'.config/mlx-scope'),{recursive:true});
  await writeFile(join(home,'.config/opencode/opencode.json'),JSON.stringify({mcp:{servers:{'comfyui':{url:'http://127.0.0.1:9000/mcp',headers:{Authorization:'Bearer {file:~/secret}'}}}}}));
  await writeFile(mediaConfigPath(home),JSON.stringify({schemaVersion:1,sources:[{id:'disabled-comfy',kind:'comfyui',origin:'http://127.0.0.1:9000',enabled:false},{id:'comfyui',kind:'comfyui',enabled:false}]}));
  const discovery=new MediaDiscovery({home,fetchImpl:async()=>{throw new Error('No probe');}});expect(await discovery.configurations()).toEqual([]);expect(discovery.enabled).toBe(true);
  await writeFile(mediaConfigPath(home),JSON.stringify({schemaVersion:1,enabled:false}));discovery.invalidate();expect(await discovery.configurations()).toEqual([]);expect(discovery.enabled).toBe(false);
});
test('parallel Comfy nodes remain indeterminate and sequential nodes have distinct phase identities',async()=>{
  const directory=await temp(),tokenPath=join(directory,'token');await writeFile(tokenPath,'a'.repeat(32),{mode:0o600});
  let nodes=[{promptId:'job',nodeId:'1',phase:'sampling',progress:{value:3,total:10,unit:'steps'}},{promptId:'job',nodeId:'2',phase:'decoding',progress:{value:1,total:4,unit:'units'}}];
  const opts=options(async input=>String(input).includes('/api/jobs')?json({jobs:[{id:'job',status:'in_progress'}]}):helper(NOW,nodes));
  const config={...COMFY,helperTokenPath:tokenPath};let job=(await comfyUI(config,opts)).jobs[0];expect(job?.progress).toBeNull();expect(job?.phase).toBe('unknown');
  nodes=nodes.slice(0,1);job=(await comfyUI(config,opts)).jobs[0];const key=job?.phaseKey;expect(key).toHaveLength(64);nodes[0]!.nodeId='3';
  expect((await comfyUI(config,opts)).jobs[0]?.phaseKey).not.toBe(key);
});
test('failed ComfyUI jobs report an allowlisted message and no live progress', async () => {
  const out = await comfyUI(COMFY, options(async () => json({ jobs: [{ id: 'job', status: 'failed', execution_end_time: new Date(NOW).toISOString() }] })));
  expect(out.jobs[0]).toMatchObject({ state: 'failed', phase: 'failed', message: 'Generation failed. Check ComfyUI.', progress: null, cancel: { supported: false }, finishedAtMs: NOW, freshness: 'last' });
});
test('producer observations created during HTTP reads are compared to response time',async()=>{
  let now=NOW;const directory=await temp(),tokenPath=join(directory,'token');await writeFile(tokenPath,'a'.repeat(32),{mode:0o600});
  const out=await comfyUI({...COMFY,helperTokenPath:tokenPath},{now:()=>now,fetchImpl:async input=>String(input).includes('/api/jobs')?json({jobs:[{id:'job',status:'in_progress'}]}):(now+=10,helper(now,[{promptId:'job',phase:'preparing',progress:{value:1,total:4,unit:'steps'}}]))});
  expect(out.jobs[0]?.observedAtMs).toBe(NOW+10);expect(out.jobs[0]?.sampledAtMs).toBe(NOW+10);expect(out.jobs[0]?.freshness).toBe('live');
});
test('whole snapshots share concurrent composition and briefly cached responses while explicit changes invalidate them',async()=>{
  let now=NOW,configs=0;
  const service=new MediaService({home:await temp(),now:()=>now,configurations:async()=>{configs++;return[COMFY];},fetchImpl:async()=>json({jobs:[{id:'job',status:'in_progress'}]})});
  const a=await Promise.all([service.snapshot(),service.snapshot(),service.snapshot(),service.snapshot()]);expect(configs).toBe(1);expect(a[0]).toBe(a[3]);
  now+=100;expect(await service.snapshot()).toBe(a[0]);expect(configs).toBe(1);
  service.invalidate();expect(await service.snapshot()).not.toBe(a[0]);expect(configs).toBe(2);
  now+=2000;await service.snapshot();expect(configs).toBe(3);
});
test('stale helper counters survive only as a static last report and clear on phase and lifecycle changes',async()=>{
  let now=NOW;const directory=await temp(),tokenPath=join(directory,'token');await writeFile(tokenPath,'a'.repeat(32),{mode:0o600});
  let nodes=[{promptId:'job',nodeId:'1',phase:'sampling',progress:{value:40,total:100,unit:'percent'}}];
  const service=new MediaService({home:directory,now:()=>now,configurations:async()=>[{...COMFY,helperTokenPath:tokenPath}],fetchImpl:async input=>String(input).includes('/api/jobs')?json({jobs:[{id:'job',status:'in_progress'}]}):helper(now-14900,nodes)});
  expect((await service.snapshot()).jobs[0]?.progress?.value).toBe(40);now+=200;
  let job=(await service.snapshot()).jobs[0];expect(job?.progress).toBeNull();expect(job?.lastProgress?.value).toBe(40);expect(job?.lastProgressAtMs).toBe(NOW-14900);expect(job?.freshness).toBe('stale');expect(job?.cancel.supported).toBe(false);
  now+=2000;nodes=[{promptId:'job',nodeId:'2',phase:'decoding',progress:{value:1,total:4,unit:'tiles'}}];job=(await service.snapshot()).jobs[0];expect(job?.phase).toBe('decoding');expect(job?.lastProgress).toBeUndefined();
  now+=2000;nodes=[];job=(await service.snapshot()).jobs[0];expect(job?.phase).toBe('unknown');expect(job?.lastProgress).toBeUndefined();
});
test('disconnected sources preserve their exact last node report without making it live',async()=>{
  let now=NOW,offline=false;const directory=await temp(),tokenPath=join(directory,'token');await writeFile(tokenPath,'a'.repeat(32),{mode:0o600});
  const service=new MediaService({home:directory,now:()=>now,configurations:async()=>[{...COMFY,helperTokenPath:tokenPath}],fetchImpl:async input=>{if(offline)throw new Error('offline');return String(input).includes('/api/jobs')?json({jobs:[{id:'job',status:'in_progress'}]}):helper(now,[{promptId:'job',nodeId:'1',phase:'sampling',progress:{value:4,total:10,unit:'steps'}}]);}});
  const live=(await service.snapshot()).jobs[0];offline=true;now+=2000;const stale=(await service.snapshot()).jobs[0];
  expect(stale?.progress).toBeNull();expect(stale?.lastProgress).toEqual(live?.progress);expect(stale?.phaseKey).toBe(live?.phaseKey);expect(stale?.lastProgressAtMs).toBe(NOW);expect(stale?.freshness).toBe('unavailable');
});
