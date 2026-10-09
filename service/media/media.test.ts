import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chatKey } from '../../src/contract/chat-key.ts';
import { classAKeys } from '../../src/contract/guards.ts';
import { comfyUI, localVideo, localFeed, qwenImage, type MediaAdapterOptions } from './adapters.ts';
import { MediaDiscovery, localOrigin, mediaConfigPath, configuredMediaSources, type MediaSourceConfig } from './discovery.ts';
import { MediaService } from './service.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const temp = async (): Promise<string> => { const directory = await mkdtemp(join(tmpdir(), 'scope-media-')); directories.push(directory); return directory; };
const NOW = 1_791_500_000_000;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const options = (fetchImpl: MediaAdapterOptions['fetchImpl']): MediaAdapterOptions => ({ now: () => NOW, fetchImpl });
const COMFY: MediaSourceConfig = { id: 'comfy', kind: 'comfyui', label: 'ComfyUI', origin: 'http://127.0.0.1:8188', version: '0.38.0' };
test('discovery is read-only, shared, finite, and fully disabled by explicit configuration', async () => {
  const home = await temp(); let calls = 0;
  const discovery = new MediaDiscovery({ home, now: () => NOW, fetchImpl: async () => { calls++; return json({ system: { comfyui_version: '0.38.0' } }); } });
  const [a,b] = await Promise.all([discovery.configurations(), discovery.configurations()]);
  expect(a).toEqual(b); expect(a[0]?.origin).toBe('http://127.0.0.1:8188'); expect(calls).toBe(1);
  await mkdir(join(home, '.config/mlx-scope'), { recursive: true });
  await writeFile(mediaConfigPath(home), JSON.stringify({ schemaVersion: 1, enabled: false }));
  discovery.invalidate(); expect(await discovery.configurations()).toEqual([]); expect(calls).toBe(1);
  for (const invalid of ['http://example.com', 'http://localhost.evil', 'file:///etc/passwd', 'http://user:pass@localhost', 'http://localhost/foo']) expect(localOrigin(invalid)).toBeNull();
});
test('Local video preserves phase counters and hashes ownership without exposing raw records', async () => {
  const directory = await temp(); await mkdir(join(directory, 'running'));
  const id = '20261009T002930-681f21ae';
  await writeFile(join(directory, 'running', `${id}.json`), JSON.stringify({ id, name: 'private prompt', session_id: 'session-A', queued_at: NOW-1000,
    progress: { phase: 'encoding references', step: 80, total: 100, unit: 'blocks', observed_at: new Date(NOW).toISOString() }, prompt: 'secret', result: { path: '/secret/image.png' } }));
  const out = await localVideo({ id: 'video', kind: 'local-video', label: 'Video', directory }, { ...options(async () => { throw new Error('No network'); }), cancelLocalVideo: async () => true, localVideoDirectory: directory });
  expect(out.jobs[0]?.phase).toBe('encoding-references'); expect(out.jobs[0]?.progress).toEqual({ value:80,total:100,unit:'blocks',basis:'phase' });
  expect(out.jobs[0]?.ownership.sessionKey).toBe(chatKey('session', 'session-A')); expect(out.jobs[0]?.cancel.supported).toBe(true);
  expect(JSON.stringify(out)).not.toContain('private prompt'); expect(JSON.stringify(out)).not.toContain('session-A'); expect(classAKeys(out)).toEqual([]);
});
test('Local video withdraws stale data and never targets a different custom queue for cancellation', async () => {
  const directory = await temp(); await mkdir(join(directory, 'running'));
  await writeFile(join(directory, 'running', 'job.json'), JSON.stringify({ id:'job', progress: { phase:'sampling',step:1,total:4,observed_at:NOW-60_000 } }));
  const out = await localVideo({ id:'video',kind:'local-video',label:'Video',directory }, { ...options(fetch), cancelLocalVideo: async () => true, localVideoDirectory: '/another-queue' });
  expect(out.jobs[0]?.freshness).toBe('stale'); expect(out.jobs[0]?.progress).toBeNull(); expect(out.jobs[0]?.cancel.supported).toBe(false);
});
test('ComfyUI lifecycle works without helper and queue fallback stays indeterminate', async () => {
  const out = await comfyUI(COMFY, options(async input => String(input).includes('/api/jobs') ? json({},404) : json({queue_running:[[0,'prompt1', {private:'prompt'}, {},[]]],queue_pending:[]})));
  expect(out.jobs[0]?.state).toBe('running'); expect(out.jobs[0]?.progress).toBeNull(); expect(out.jobs[0]?.cancel.supported).toBe(false); expect(classAKeys(out)).toEqual([]);
});
test('ComfyUI helper only applies measured counters to the exact running prompt', async () => {
  const directory = await temp(), tokenPath=join(directory,'token'); await writeFile(tokenPath,'a'.repeat(32),{mode:0o600});
  let value=0,total=1, promptId='prompt1';
  const opts=options(async input=>String(input).includes('/api/jobs')?json({jobs:[{id:'prompt1',status:'in_progress'}]}):json({schemaVersion:1,helperVersion:'1.0.0',comfyVersion:'0.38.0',supported:true,observedAtMs:NOW,jobs:[{promptId,phase:'sampling',progress:{value,total,unit:'steps'}}]}));
  const config={...COMFY,helperTokenPath:tokenPath};
  expect((await comfyUI(config,opts)).jobs[0]?.progress).toBeNull(); value=2;total=10;
  expect((await comfyUI(config,opts)).jobs[0]?.progress?.value).toBe(2); promptId='other';
  expect((await comfyUI(config,opts)).jobs[0]?.progress).toBeNull();
});
test('Qwen begins reporting before prompt submission, carries no prompt content, and separates observation from progress', async()=>{
  const out=await qwenImage({id:'qwen',kind:'qwen-image',label:'Image',origin:'http://127.0.0.1:9000'},options(async()=>json({schemaVersion:1,producer:'qwen-image',observedAtMs:NOW,jobs:[{jobId:'image-1',state:'waiting',phase:'waiting',createdAtMs:NOW-20000,updatedAtMs:NOW-20000,sessionId:'private-session',canCancel:true,prompt:'secret'}]})));
  expect(out.jobs[0]?.freshness).toBe('live');expect(out.jobs[0]?.progressAtMs).toBe(NOW-20000);expect(out.jobs[0]?.phase).toBe('waiting');expect(classAKeys(out)).toEqual([]);
});
test('private feed rejects symlinks, public permissions, expiry and unsupported versions',async()=>{
  const directory=await temp(), outside=join(await temp(),'outside.json');
  const body={schemaVersion:1,observedAtMs:NOW,expiresAtMs:NOW+5000,jobs:[{id:'job',kind:'image',state:'running',phase:'sampling',progress:{value:1,total:4,unit:'steps',basis:'phase'},ownership:{},cancel:{supported:true}}]};
  await writeFile(outside,JSON.stringify(body),{mode:0o600});await symlink(outside,join(directory,'linked.json'));
  const path=join(directory,'valid.json');await writeFile(path,JSON.stringify(body),{mode:0o644});
  const config:MediaSourceConfig={id:'feed',kind:'feed',label:'Feed',directory};
  expect((await localFeed(config,options(fetch))).jobs).toEqual([]);await chmod(path,0o600);
  expect((await localFeed(config,options(fetch))).jobs[0]?.cancel.supported).toBe(false);
  await writeFile(path,JSON.stringify({...body,expiresAtMs:NOW-1}));expect((await localFeed(config,options(fetch))).jobs).toEqual([]);
});
test('shared collection coalesces visible reads, has no background requests, preserves progress-change time, and withdraws disconnected values',async()=>{
  let now=NOW,calls=0,offline=false,value=1;
  const directory=await temp(), tokenPath=join(directory,'token');await writeFile(tokenPath,'a'.repeat(32),{mode:0o600});
  const service=new MediaService({home:directory,now:()=>now,configurations:async()=>[{...COMFY,helperTokenPath:tokenPath}],fetchImpl:async input=>{calls++;if(offline)throw new Error('offline');return String(input).includes('/api/jobs')?json({jobs:[{id:'job',status:'in_progress'}]}):json({schemaVersion:1,helperVersion:'1.0.0',comfyVersion:'0.38.0',supported:true,observedAtMs:now,jobs:[{promptId:'job',phase:'sampling',progress:{value,total:10,unit:'steps'}}]});}});
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
test('Qwen ownership and Comfy counters become one job, while unrelated simultaneous jobs remain unassigned',async()=>{
  const directory=await temp(),tokenPath=join(directory,'token');await writeFile(tokenPath,'a'.repeat(32),{mode:0o600});
  const qwen:MediaSourceConfig={id:'qwen',kind:'qwen-image',label:'Qwen',origin:'http://127.0.0.1:9000'};
  const service=new MediaService({home:directory,now:()=>NOW,configurations:async()=>[{...COMFY,helperTokenPath:tokenPath},qwen],fetchImpl:async input=>{
    const url=String(input);
    if(url.includes(':9000'))return json({schemaVersion:1,producer:'qwen-image',observedAtMs:NOW,jobs:[{jobId:'image1',promptId:'prompt1',sessionId:'session1',state:'running',phase:'unknown',createdAtMs:NOW-1000,updatedAtMs:NOW,canCancel:false}]});
    if(url.includes('/api/jobs'))return json({jobs:[{id:'prompt1',status:'in_progress'},{id:'prompt2',status:'pending'}]});
    return json({schemaVersion:1,helperVersion:'1.0.0',comfyVersion:'0.38.0',supported:true,observedAtMs:NOW,jobs:[{promptId:'prompt1',phase:'sampling',progress:{value:3,total:10,unit:'steps'}}]});
  }});
  const snapshot=await service.snapshot();expect(snapshot.jobs).toHaveLength(2);
  const owned=snapshot.jobs.find(job=>job.sourceId==='qwen');expect(owned?.id).toBe('image1');expect(owned?.progress?.value).toBe(3);expect(owned?.ownership.sessionKey).toBe(chatKey('session','session1'));
  expect(snapshot.jobs.find(job=>job.id==='prompt2')?.ownership).toEqual({});
});
test('source endpoint changes discard cached readings immediately',async()=>{
  let origin='http://127.0.0.1:8188';
  const service=new MediaService({home:await temp(),now:()=>NOW,configurations:async()=>[{...COMFY,origin}],fetchImpl:async input=>json({jobs:[{id:String(input).includes(':8188')?'old-job':'new-job',status:'in_progress'}]})});
  expect((await service.snapshot()).jobs[0]?.id).toBe('old-job');origin='http://127.0.0.1:8189';
  service.invalidate();
  expect((await service.snapshot()).jobs[0]?.id).toBe('new-job');
});
test('OpenCode discovery reads JSONC v2 metadata without probing tools, exposing credentials or discovering unrelated MCP servers',async()=>{
  const home=await temp(),directory=join(home,'.config/opencode');await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'opencode.jsonc'),`{ // existing comments remain untouched
    "mcp":{"servers":{
      "qwen-image":{"type":"remote","url":"http://127.0.0.1:9000/mcp","headers":{"Authorization":"Bearer {file:~/private/qwen-token}"}},
      "comfyui":{"type":"local","command":["python","main.py"],"environment":{"COMFYUI_DIR":"${home}/ComfyUI","COMFY_PORT":"8190"}},
      "unrelated":{"type":"remote","url":"http://127.0.0.1:9999/mcp","headers":{"Authorization":"Bearer private-secret"}},
      "qwen-image-remote":{"type":"remote","url":"https://example.com/mcp","headers":{"Authorization":"Bearer {file:~/private/token}"}},
      "qwen-image-disabled":{"enabled":false,"url":"http://127.0.0.1:9001/mcp","headers":{"Authorization":"Bearer {file:~/private/token}"}}
    }}}
  `);
  const sources=await configuredMediaSources(home);expect(sources).toHaveLength(2);expect(sources[0]?.kind).toBe('qwen-image');expect(sources[0]?.tokenPath).toBe(join(home,'private/qwen-token'));
  expect(sources[1]?.origin).toBe('http://127.0.0.1:8190');expect(JSON.stringify(sources)).not.toContain('private-secret');
});
test('disabled sources cannot be rediscovered under another automatic id',async()=>{
  const home=await temp();await mkdir(join(home,'.config/opencode'),{recursive:true});await mkdir(join(home,'.config/mlx-scope'),{recursive:true});
  await writeFile(join(home,'.config/opencode/opencode.json'),JSON.stringify({mcp:{servers:{'qwen-image':{url:'http://127.0.0.1:9000/mcp',headers:{Authorization:'Bearer {file:~/secret}'}}}}}));
  await writeFile(mediaConfigPath(home),JSON.stringify({schemaVersion:1,sources:[{id:'disabled-qwen',kind:'qwen-image',origin:'http://127.0.0.1:9000',enabled:false},{id:'comfyui',kind:'comfyui',enabled:false}]}));
  const discovery=new MediaDiscovery({home,fetchImpl:async()=>{throw new Error('No probe');}});expect(await discovery.configurations()).toEqual([]);expect(discovery.enabled).toBe(true);
  await writeFile(mediaConfigPath(home),JSON.stringify({schemaVersion:1,enabled:false}));discovery.invalidate();expect(await discovery.configurations()).toEqual([]);expect(discovery.enabled).toBe(false);
});
test('parallel Comfy nodes remain indeterminate and sequential nodes have distinct phase identities',async()=>{
  const directory=await temp(),tokenPath=join(directory,'token');await writeFile(tokenPath,'a'.repeat(32),{mode:0o600});
  let nodes=[{promptId:'job',nodeId:'1',phase:'sampling',progress:{value:3,total:10,unit:'steps'}},{promptId:'job',nodeId:'2',phase:'decoding',progress:{value:1,total:4,unit:'units'}}];
  const opts=options(async input=>String(input).includes('/api/jobs')?json({jobs:[{id:'job',status:'in_progress'}]}):json({schemaVersion:1,helperVersion:'1.0.0',comfyVersion:'0.38.0',supported:true,observedAtMs:NOW,jobs:nodes}));
  const config={...COMFY,helperTokenPath:tokenPath};let job=(await comfyUI(config,opts)).jobs[0];expect(job?.progress).toBeNull();expect(job?.phase).toBe('unknown');
  nodes=nodes.slice(0,1);job=(await comfyUI(config,opts)).jobs[0];const key=job?.phaseKey;expect(key).toHaveLength(64);nodes[0]!.nodeId='3';
  expect((await comfyUI(config,opts)).jobs[0]?.phaseKey).not.toBe(key);
});
test('producer observations created during HTTP reads are compared to response time',async()=>{
  let now=NOW;
  const out=await qwenImage({id:'qwen',kind:'qwen-image',label:'Image',origin:'http://127.0.0.1:9000'},{now:()=>now,fetchImpl:async()=>{now+=10;return json({schemaVersion:1,producer:'qwen-image',observedAtMs:now,jobs:[{jobId:'image1',state:'running',phase:'preparing',createdAtMs:now,updatedAtMs:now,canCancel:false}]});}});
  expect(out.jobs[0]?.observedAtMs).toBe(NOW+10);expect(out.jobs[0]?.sampledAtMs).toBe(NOW+10);expect(out.jobs[0]?.freshness).toBe('live');
});
test('native phase percentages remain measured when unit counters are absent and still expire',async()=>{
  const directory=await temp();await mkdir(join(directory,'running'));const path=join(directory,'running','job.json');
  const record={id:'job',progress:{phase:'sampling',step:null,total:null,percent:30.5,observed_at:NOW}};
  await writeFile(path,JSON.stringify(record));const config:MediaSourceConfig={id:'video',kind:'local-video',label:'Video',directory};
  expect((await localVideo(config,options(fetch))).jobs[0]?.progress).toEqual({value:30.5,total:100,unit:'percent',basis:'phase'});
  record.progress.observed_at=NOW-16000;await writeFile(path,JSON.stringify(record));expect((await localVideo(config,options(fetch))).jobs[0]?.progress).toBeNull();
});
test('whole snapshots share concurrent composition and briefly cached responses while explicit changes invalidate them',async()=>{
  let now=NOW,configs=0;
  const service=new MediaService({home:await temp(),now:()=>now,configurations:async()=>{configs++;return[COMFY];},fetchImpl:async()=>json({jobs:[{id:'job',status:'in_progress'}]})});
  const a=await Promise.all([service.snapshot(),service.snapshot(),service.snapshot(),service.snapshot()]);expect(configs).toBe(1);expect(a[0]).toBe(a[3]);
  now+=100;expect(await service.snapshot()).toBe(a[0]);expect(configs).toBe(1);
  service.invalidate();expect(await service.snapshot()).not.toBe(a[0]);expect(configs).toBe(2);
  now+=2000;await service.snapshot();expect(configs).toBe(3);
});
test('stale video counters survive only as a static last report and clear on phase and lifecycle changes',async()=>{
  let now=NOW;const directory=await temp();await mkdir(join(directory,'running'));const path=join(directory,'running','job.json');
  const record={id:'job',progress:{phase:'sampling',percent:40,observed_at:NOW-14900}};
  await writeFile(path,JSON.stringify(record));const service=new MediaService({home:directory,now:()=>now,configurations:async()=>[{id:'video',kind:'local-video',label:'Video',directory}]});
  expect((await service.snapshot()).jobs[0]?.progress?.value).toBe(40);now+=200;
  let job=(await service.snapshot()).jobs[0];expect(job?.progress).toBeNull();expect(job?.lastProgress?.value).toBe(40);expect(job?.lastProgressAtMs).toBe(NOW-14900);expect(job?.freshness).toBe('stale');expect(job?.cancel.supported).toBe(false);
  now+=2000;await writeFile(path,JSON.stringify({id:'job',progress:{phase:'decoding',observed_at:now}}));job=(await service.snapshot()).jobs[0];expect(job?.phase).toBe('decoding');expect(job?.lastProgress).toBeUndefined();
  now+=2000;await writeFile(path,JSON.stringify({id:'job',waiting_reason:'chat handoff',progress:{phase:'sampling',percent:40,observed_at:NOW-60000}}));job=(await service.snapshot()).jobs[0];expect(job?.state).toBe('waiting');expect(job?.lastProgress).toBeUndefined();
});
test('disconnected sources preserve their exact last node report without making it live',async()=>{
  let now=NOW,offline=false;const directory=await temp(),tokenPath=join(directory,'token');await writeFile(tokenPath,'a'.repeat(32),{mode:0o600});
  const service=new MediaService({home:directory,now:()=>now,configurations:async()=>[{...COMFY,helperTokenPath:tokenPath}],fetchImpl:async input=>{if(offline)throw new Error('offline');return String(input).includes('/api/jobs')?json({jobs:[{id:'job',status:'in_progress'}]}):json({schemaVersion:1,helperVersion:'1.0.0',comfyVersion:'0.38.0',supported:true,observedAtMs:now,jobs:[{promptId:'job',nodeId:'1',phase:'sampling',progress:{value:4,total:10,unit:'steps'}}]});}});
  const live=(await service.snapshot()).jobs[0];offline=true;now+=2000;const stale=(await service.snapshot()).jobs[0];
  expect(stale?.progress).toBeNull();expect(stale?.lastProgress).toEqual(live?.progress);expect(stale?.phaseKey).toBe(live?.phaseKey);expect(stale?.lastProgressAtMs).toBe(NOW);expect(stale?.freshness).toBe('unavailable');
});
test('video history is revalidated slowly while new completions and active progress appear immediately',async()=>{
  let now=NOW;const directory=await temp();for(const bucket of ['running','done','pending','failed','cancelled'])await mkdir(join(directory,bucket));
  const old=join(directory,'done','old.json'),active=join(directory,'running','active.json');
  await writeFile(old,JSON.stringify({id:'old',finished_at:NOW-10000}));await writeFile(active,JSON.stringify({id:'active',progress:{phase:'sampling',percent:10,observed_at:NOW}}));
  const service=new MediaService({home:directory,now:()=>now,configurations:async()=>[{id:'video',kind:'local-video',label:'Video',directory}]});
  expect((await service.snapshot()).jobs.find(job=>job.id==='old')?.finishedAtMs).toBe(NOW-10000);
  now+=2000;await writeFile(old,JSON.stringify({id:'old',finished_at:NOW-5000}));await writeFile(active,JSON.stringify({id:'active',progress:{phase:'sampling',percent:20,observed_at:now}}));
  let snapshot=await service.snapshot();expect(snapshot.jobs.find(job=>job.id==='active')?.progress?.value).toBe(20);expect(snapshot.jobs.find(job=>job.id==='old')?.finishedAtMs).toBe(NOW-10000);
  now+=2000;await rename(active,join(directory,'done','active.json'));snapshot=await service.snapshot();expect(snapshot.jobs.find(job=>job.id==='active')?.state).toBe('completed');expect(snapshot.jobs.find(job=>job.id==='active')?.lastProgress).toBeUndefined();expect(snapshot.jobs.find(job=>job.id==='old')?.finishedAtMs).toBe(NOW-5000);
  await writeFile(old,JSON.stringify({id:'old',finished_at:NOW-1000}));now+=31000;snapshot=await service.snapshot();expect(snapshot.jobs.find(job=>job.id==='old')?.finishedAtMs).toBe(NOW-1000);
});
