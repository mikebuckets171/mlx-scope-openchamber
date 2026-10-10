import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chatKey } from '../../src/contract/chat-key.ts';
import { classAKeys } from '../../src/contract/guards.ts';
import { comfyUI, localVideo, localFeed, qwenImage, type MediaAdapterOptions } from './adapters.ts';
import { MediaDiscovery, localOrigin, mediaConfigPath, configuredMediaSources, type MediaSourceConfig } from './discovery.ts';
import { MediaService, RATE_SAMPLE_LIMIT, measuredFinish } from './service.ts';
import { parseMediaJob, type MediaJobV1, type MediaProgressV1 } from '../../src/contract/media.ts';

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

// Finish-time estimates. The private feed is the only source that can declare a final phase, so it drives these fixtures.
const wire = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value));
const steps = (value: number, total = 20): MediaProgressV1 => ({ value, total, unit: 'steps', basis: 'phase' });
const render = (progress: MediaProgressV1, change: Record<string, unknown> = {}) => ({ id: 'render-42', kind: 'video', state: 'running', phase: 'sampling', progress, ownership: {}, finalPhase: true, ...change });
const publish = async (directory: string, observedAtMs: number, jobs: unknown[]): Promise<void> => {
  const path = join(directory, 'studio.json');
  await writeFile(path, JSON.stringify({ schemaVersion: 1, observedAtMs, expiresAtMs: observedAtMs + 30_000, jobs }), { mode: 0o600 }); await chmod(path, 0o600);
};
const feedService = async (clock: () => number) => {
  const home = await temp(), directory = join(home, 'feed'); await mkdir(directory);
  return { directory, service: new MediaService({ home, now: clock, configurations: async () => [{ id: 'feed', kind: 'feed', label: 'Feed', directory }] }) };
};
/** One producer report at NOW + offset, read by Scope one second later. */
const reporter = async () => {
  let now = NOW; const { directory, service } = await feedService(() => now);
  const report = async (offset: number, progress: MediaProgressV1, change: Record<string, unknown> = {}): Promise<MediaJobV1 | undefined> => {
    now = NOW + offset + 1_000; await publish(directory, NOW + offset, [render(progress, { progressAtMs: NOW + offset, ...change })]);
    return (await service.snapshot()).jobs[0];
  };
  return { directory, service, report, at: (value: number) => { now = value; } };
};
test('measured finish needs two strictly increasing samples, a positive rate and a plausible horizon', () => {
  expect(measuredFinish([], 20, 0)).toBeUndefined();
  expect(measuredFinish([{ at: 0, value: 4 }], 20, 0)).toBeUndefined();
  expect(measuredFinish([{ at: 0, value: 4 }, { at: 10_000, value: 8 }], 20, 10_000)).toBe(40_000);
  expect(measuredFinish([{ at: 0, value: 4 }, { at: 10_000, value: 4 }], 20, 10_000)).toBeUndefined();
  expect(measuredFinish([{ at: 10_000, value: 4 }, { at: 10_000, value: 8 }], 20, 10_000)).toBeUndefined();
  expect(measuredFinish([{ at: 10_000, value: 8 }, { at: 0, value: 4 }], 20, 10_000)).toBeUndefined();
  expect(measuredFinish([{ at: 0, value: 4 }, { at: 10_000, value: 20 }], 20, 12_000)).toBe(12_000); // never before the latest report
  expect(measuredFinish([{ at: 0, value: 0 }, { at: 1_000, value: 1 }], 86_401, 1_000)).toBe(86_401_000); // exactly 24 h after the report
  expect(measuredFinish([{ at: 0, value: 0 }, { at: 1_000, value: 1 }], 86_402, 1_000)).toBeUndefined(); // beyond 24 h
  expect(measuredFinish([{ at: 0, value: 0 }, { at: 1_000, value: 1 }], 86_401, 86_402_000)).toBeUndefined();
});
test('a finish estimate needs two producer-timestamped samples of a declared final phase and ignores Scope read times', async () => {
  let now = NOW; const { directory, service } = await feedService(() => now);
  await publish(directory, NOW - 5_000, [render(steps(4), { progressAtMs: NOW - 6_000 })]);
  let job = (await service.snapshot()).jobs[0];
  expect(job?.progressAtMs).toBe(NOW - 6_000); expect(job?.progress?.value).toBe(4);
  for (const key of ['etaAtMs', 'lastEtaAtMs', 'etaBasis', 'finalPhase']) expect(wire(job)).not.toHaveProperty(key); // one sample is no rate
  now = NOW + 30_000; await publish(directory, NOW + 25_000, [render(steps(8), { progressAtMs: NOW + 20_000 })]);
  job = (await service.snapshot()).jobs[0];
  // 4 steps in 26 s of producer time leaves 12 steps, 78 s after the latest report. Scope's reads were 30 s apart.
  expect(job?.etaAtMs).toBe(NOW + 98_000); expect(job?.etaBasis).toBe('measured-window'); expect(wire(job)).not.toHaveProperty('finalPhase');
  expect(parseMediaJob(wire(job))).toMatchObject({ etaAtMs: NOW + 98_000, etaBasis: 'measured-window' });
});
test('without a producer progress time, the observation that first carried each value is the sample time', async () => {
  let now = NOW; const { directory, service } = await feedService(() => now);
  await publish(directory, NOW - 5_000, [render(steps(4))]); expect((await service.snapshot()).jobs[0]?.etaAtMs).toBeUndefined();
  now = NOW + 30_000; await publish(directory, NOW + 25_000, [render(steps(8))]);
  // 4 steps in the producer's 30 s; 12 remain: 90 s after the producer's report, not after Scope's read.
  expect((await service.snapshot()).jobs[0]?.etaAtMs).toBe(NOW + 115_000);
  now = NOW + 40_000; await publish(directory, NOW + 35_000, [render(steps(8))]); // re-reporting the same value keeps its first time
  expect((await service.snapshot()).jobs[0]?.etaAtMs).toBe(NOW + 115_000);
});
test('estimates are never stitched across phases, nodes or counter units', async () => {
  const { report } = await reporter(), tiles = (value: number): MediaProgressV1 => ({ value, total: 10, unit: 'tiles', basis: 'phase' });
  await report(0, steps(4)); expect((await report(10_000, steps(8)))?.etaAtMs).toBe(NOW + 40_000);
  expect((await report(20_000, tiles(1), { phase: 'decoding' }))?.etaAtMs).toBeUndefined();
  expect((await report(30_000, tiles(2), { phase: 'decoding' }))?.etaAtMs).toBe(NOW + 110_000); // only decoding's own rate
  expect((await report(40_000, tiles(3), { phase: 'decoding', phaseKey: 'a'.repeat(64) }))?.etaAtMs).toBeUndefined();
  expect((await report(45_000, tiles(4), { phase: 'decoding', phaseKey: 'a'.repeat(64) }))?.etaAtMs).toBe(NOW + 75_000);
  expect((await report(50_000, { value: 5, total: 12, unit: 'tiles', basis: 'phase' }, { phase: 'decoding', phaseKey: 'a'.repeat(64) }))?.etaAtMs).toBeUndefined();
  expect((await report(52_000, { value: 5, total: 10, unit: 'blocks', basis: 'phase' }, { phase: 'decoding', phaseKey: 'a'.repeat(64) }))?.etaAtMs).toBeUndefined();
  // Indeterminate progress in between also ends the window.
  await report(54_000, steps(4)); await report(56_000, steps(6)); expect((await report(58_000, steps(8)))?.etaAtMs).toBeDefined();
  expect((await report(60_000, steps(0), { progress: null }))?.progress).toBeNull();
  expect((await report(62_000, steps(10)))?.etaAtMs).toBeUndefined();
});
test('only a source-declared final phase gets an estimate, and producer-supplied estimates are ignored', async () => {
  for (const declaration of [{ finalPhase: undefined }, { finalPhase: false }, { finalPhase: 'true' }, { finalPhase: 1 }]) {
    const { report } = await reporter();
    await report(0, steps(4), declaration); const job = await report(10_000, steps(8), { ...declaration, etaAtMs: NOW + 20_000, etaBasis: 'measured-window', lastEtaAtMs: NOW + 20_000 });
    expect(job?.progress?.value).toBe(8); for (const key of ['etaAtMs', 'lastEtaAtMs', 'etaBasis']) expect(wire(job)).not.toHaveProperty(key);
  }
  // A declaration covers the current phase: its own earlier samples are a valid measurement once the source declares it final.
  const { report } = await reporter();
  await report(0, steps(4), { finalPhase: undefined }); await report(10_000, steps(8), { finalPhase: undefined });
  expect((await report(20_000, steps(12)))?.etaAtMs).toBe(NOW + 40_000);
  expect((await report(30_000, steps(14), { finalPhase: false }))?.etaAtMs).toBeUndefined();
});
test('built-in adapters declare no final phase: local video and ComfyUI never estimate', async () => {
  let now = NOW; const directory = await temp(); await mkdir(join(directory, 'running')); const path = join(directory, 'running', 'job.json');
  const video = new MediaService({ home: directory, now: () => now, configurations: async () => [{ id: 'video', kind: 'local-video', label: 'Video', directory }] });
  for (const [offset, step] of [[0, 4], [10_000, 8], [20_000, 12]] as const) {
    now = NOW + offset + 1_000; await writeFile(path, JSON.stringify({ id: 'job', progress: { phase: 'sampling', step, total: 20, observed_at: NOW + offset } }));
    const job = (await video.snapshot()).jobs[0]; expect(job?.progress?.value).toBe(step); expect(wire(job)).not.toHaveProperty('etaAtMs');
  }
  const tokenPath = join(directory, 'token'); await writeFile(tokenPath, 'a'.repeat(32), { mode: 0o600 }); let value = 2; now = NOW;
  const comfy = new MediaService({ home: directory, now: () => now, configurations: async () => [{ ...COMFY, helperTokenPath: tokenPath }], fetchImpl: async input => String(input).includes('/api/jobs')
    ? json({ jobs: [{ id: 'job', status: 'in_progress' }] }) : json({ schemaVersion: 1, helperVersion: '1.0.0', comfyVersion: '0.38.0', supported: true, observedAtMs: now, jobs: [{ promptId: 'job', nodeId: '3', phase: 'sampling', progressChangedAtMs: now, progress: { value, total: 20, unit: 'steps' } }] }) });
  for (const step of [2, 6, 10]) { value = step; now += 5_000; const job = (await comfy.snapshot()).jobs[0]; expect(job?.progress?.value).toBe(step); expect(wire(job)).not.toHaveProperty('etaAtMs'); }
});
test('a rate needs strictly increasing values and producer times', async () => {
  const { report } = await reporter();
  await report(0, steps(4)); expect((await report(10_000, steps(4)))?.etaAtMs).toBeUndefined(); // no change, no rate
  expect((await report(20_000, steps(3)))?.etaAtMs).toBeUndefined(); // a counter that runs backwards starts again
  expect((await report(30_000, steps(5)))?.etaAtMs).toBe(NOW + 105_000); // 2 steps in 10 s from the restart only
  expect((await report(40_000, steps(5)))?.etaAtMs).toBe(NOW + 105_000);
  expect((await report(50_000, steps(6), { progressAtMs: NOW + 25_000 }))?.etaAtMs).toBeUndefined(); // a later value cannot predate the last
});
test('the rate window is bounded to the most recent distinct reports', async () => {
  const { report } = await reporter(); let job: MediaJobV1 | undefined;
  // Two slow reports, then eight fast ones: only the latest eight samples set the rate.
  const offsets = [0, 60_000, ...Array.from({ length: 8 }, (_, index) => 120_000 + index * 2_000)];
  for (const [index, offset] of offsets.entries()) job = await report(offset, steps(index + 1));
  expect(RATE_SAMPLE_LIMIT).toBe(8);
  expect(job?.etaAtMs).toBe(NOW + 134_000 + 20_000); // values 3–10 over 14 s; 10 steps remain at 0.5 per second
});
test('a stale or disconnected job holds its last estimate as history and never extends it', async () => {
  const { directory, report, service, at } = await reporter();
  await report(0, steps(4)); expect((await report(10_000, steps(8)))?.etaAtMs).toBe(NOW + 40_000);
  at(NOW + 26_000); let job: MediaJobV1 | undefined = (await service.snapshot()).jobs[0];
  expect(job).toMatchObject({ freshness: 'stale', progress: null, lastProgress: steps(8), lastProgressAtMs: NOW + 10_000, lastEtaAtMs: NOW + 40_000, etaBasis: 'measured-window' });
  expect(wire(job)).not.toHaveProperty('etaAtMs'); expect(parseMediaJob(wire(job))?.lastEtaAtMs).toBe(NOW + 40_000);
  at(NOW + 38_000); expect((await service.snapshot()).jobs[0]?.lastEtaAtMs).toBe(NOW + 40_000); // the same estimate, not re-projected
  // Live again in the same phase: the producer-timed samples still measure this phase.
  job = await report(70_000, steps(12)); expect(job?.etaAtMs).toBe(NOW + 140_000); expect(wire(job)).not.toHaveProperty('lastEtaAtMs');
  // A disconnected source withdraws the live estimate into the held field.
  await rm(directory, { recursive: true, force: true }); at(NOW + 74_000); job = (await service.snapshot()).jobs[0];
  expect(job).toMatchObject({ freshness: 'unavailable', progress: null, lastProgress: steps(12), lastEtaAtMs: NOW + 140_000, etaBasis: 'measured-window' });
  expect(wire(job)).not.toHaveProperty('etaAtMs');
});
test('waiting, cancellation and completion end the estimate', async () => {
  const { report } = await reporter();
  await report(0, steps(4)); await report(10_000, steps(8));
  const waiting = await report(20_000, steps(8), { state: 'waiting', phase: 'waiting', progress: null });
  for (const key of ['etaAtMs', 'lastEtaAtMs', 'etaBasis']) expect(wire(waiting)).not.toHaveProperty(key);
  expect((await report(30_000, steps(9)))?.etaAtMs).toBeUndefined(); // a paused job starts a new measurement
  expect((await report(32_000, steps(10)))?.etaAtMs).toBeDefined();
  const cancelling = await report(34_000, steps(10), { state: 'cancelling', progress: null });
  expect(cancelling?.state).toBe('cancelling'); for (const key of ['etaAtMs', 'lastEtaAtMs', 'etaBasis']) expect(wire(cancelling)).not.toHaveProperty(key);
  const done = await report(40_000, steps(20), { state: 'completed', phase: 'completed', progress: null, finishedAtMs: NOW + 39_000 });
  expect(done?.finishedAtMs).toBe(NOW + 39_000); for (const key of ['etaAtMs', 'lastEtaAtMs', 'etaBasis']) expect(wire(done)).not.toHaveProperty(key);
});

test('a correlated ComfyUI prompt is reconciled into its bridge job before its duplicate entry is removed', async () => {
  const home = await temp(), tokenPath = join(home, 'token'); await writeFile(tokenPath, 'a'.repeat(32), { mode: 0o600 });
  const comfy: MediaSourceConfig = { ...COMFY, helperTokenPath: tokenPath };
  const qwen: MediaSourceConfig = { id: 'qwen', kind: 'qwen-image', label: 'Image', origin: 'http://127.0.0.1:9000' };
  let bridge: Record<string, unknown> = { jobId: 'image-1', state: 'queued', phase: 'queued', promptId: 'prompt1', sessionId: 'session-A',
    createdAtMs: NOW - 20_000, updatedAtMs: NOW - 20_000, canCancel: true };
  const fetchImpl: MediaAdapterOptions['fetchImpl'] = async input => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1:9000')) return json({ schemaVersion: 1, producer: 'qwen-image', observedAtMs: NOW, jobs: [bridge] });
    if (url.includes('/api/jobs')) return json({ jobs: [{ id: 'prompt1', status: 'in_progress' }] });
    return json({ schemaVersion: 1, helperVersion: '1.0.0', comfyVersion: '0.38.0', supported: true, observedAtMs: NOW,
      jobs: [{ promptId: 'prompt1', phase: 'sampling', progress: { value: 8, total: 20, unit: 'steps' } }] });
  };
  const service = () => new MediaService({ home, now: () => NOW, fetchImpl, configurations: async () => [comfy, qwen] });
  // Producer skew: the bridge still says queued while ComfyUI already samples. One job, with the engine's current truth.
  let jobs = (await service().snapshot()).jobs;
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ id: 'image-1', sourceId: 'qwen', state: 'running', phase: 'sampling',
    progress: { value: 8, total: 20, unit: 'steps', basis: 'phase' }, ownership: { sessionKey: chatKey('session', 'session-A') } });
  // A finished bridge keeps its own completion; the engine's running entry never resurrects it.
  bridge = { ...bridge, state: 'completed', phase: 'completed', updatedAtMs: NOW - 1_000 };
  jobs = (await service().snapshot()).jobs;
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ id: 'image-1', state: 'completed', progress: null });
});
