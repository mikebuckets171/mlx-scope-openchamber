import { afterEach, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createScopeServer, unread } from '../server.ts';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaSetupError } from './setup.ts';
import { MediaService } from './service.ts';
import { parseMediaSnapshot, type MediaSnapshotV1 } from '../../src/contract/media.ts';
const servers: Server[] = [];
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
test('a measured finish estimate reaches the panel parser through the media route, and a held one stays historical', async () => {
  const NOW = 1_791_500_000_000, home = await mkdtemp(join(tmpdir(), 'scope-media-route-')), directory = join(home, 'feed'); homes.push(home); await mkdir(directory);
  let now = NOW;
  const publish = async (at: number, value: number): Promise<void> => {
    const path = join(directory, 'studio.json');
    await writeFile(path, JSON.stringify({ schemaVersion: 1, observedAtMs: at, expiresAtMs: at + 30_000, jobs: [{ id: 'render-42', kind: 'video', state: 'running', phase: 'sampling',
      progress: { value, total: 20, unit: 'steps', basis: 'phase' }, progressAtMs: at, ownership: {}, finalPhase: true }] }), { mode: 0o600 });
    await chmod(path, 0o600);
  };
  const service = new MediaService({ home, now: () => now, configurations: async () => [{ id: 'feed', kind: 'feed', label: 'Feed', directory }] });
  const server = createScopeServer('secret', { read: async () => unread(1000), media: service });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const read = async () => {
    const body = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/media`, { headers: { Authorization: 'Bearer secret' } })).text();
    return { body, job: parseMediaSnapshot(JSON.parse(body))?.jobs[0] };
  };
  await publish(NOW, 4); now = NOW + 1_000; expect((await read()).body).not.toContain('eta');
  await publish(NOW + 10_000, 8); now = NOW + 11_000;
  let out = await read();
  expect(out.job).toMatchObject({ etaAtMs: NOW + 40_000, etaBasis: 'measured-window' }); expect(out.body).not.toContain('finalPhase'); expect(out.body).not.toContain('lastEtaAtMs');
  now = NOW + 26_000; out = await read();
  expect(out.job).toMatchObject({ freshness: 'stale', lastEtaAtMs: NOW + 40_000, etaBasis: 'measured-window' }); expect(out.job).not.toHaveProperty('etaAtMs');
});
test('shared media snapshots encode once across views and a new collection replaces the wire body', async () => {
  let encoded = 0;
  const snapshot = (at: number): MediaSnapshotV1 => ({ schemaVersion: 1, get sampledAtMs() { encoded++; return at; }, nextPollMs: 2000, sources: [], jobs: [] });
  let current = snapshot(1000);
  const server = createScopeServer('secret', { read: async () => unread(1000), media: { snapshot: async () => current,
    cancel: async (sourceId, jobId) => ({ schemaVersion: 1, sourceId, jobId, status: 'unsupported' }) } });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async () => {
    const response = await fetch(origin + '/v2/media', { headers: { Authorization: 'Bearer secret' } });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    return response.json();
  };
  const first = await Promise.all(Array.from({ length: 4 }, request));
  expect(first.every(body => body.sampledAtMs === 1000)).toBe(true); expect(encoded).toBe(1);
  current = snapshot(2000);
  expect((await request()).sampledAtMs).toBe(2000); expect(encoded).toBe(2);
});
test('media routes authenticate before any discovery, mutation, or runtime collection', async () => {
  let snapshots=0,cancels=0,setups=0,runtimes=0;
  const server=createScopeServer('secret',{read:async()=>{runtimes++;return unread(1000);},media:{snapshot:async()=>{snapshots++;return {schemaVersion:1,sampledAtMs:1000,nextPollMs:2000,sources:[],jobs:[]};},cancel:async(sourceId,jobId)=>{cancels++;return{schemaVersion:1,sourceId,jobId,status:'requested'};}},mediaSetup:{status:async()=>{setups++;return{schemaVersion:1,sources:[]};},action:async()=>{setups++;return{schemaVersion:1,sources:[]};}}});
  servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request=(path:string,body?:unknown,auth=true)=>fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{...(auth?{Authorization:'Bearer secret'}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  for(const path of ['/v2/media','/v2/media/cancel','/v2/media/setup']) expect((await request(path,{sourceId:'source',jobId:'job'},false)).status).toBe(401);
  expect([snapshots,cancels,setups,runtimes]).toEqual([0,0,0,0]);
  expect((await request('/v2/media')).status).toBe(200);expect(snapshots).toBe(1);expect(runtimes).toBe(0);
  expect((await request('/v2/media?session=private')).status).toBe(400);
  expect((await request('/v2/media',{})).status).toBe(405);
  expect((await request('/v2/media/cancel',{sourceId:'source',jobId:'job',all:true})).status).toBe(400);
  expect((await request('/v2/media/cancel',{sourceId:'source',jobId:'../../escape'})).status).toBe(400);
  expect((await request('/v2/media/cancel',{sourceId:'source',jobId:'job'})).status).toBe(200);expect(cancels).toBe(1);
  expect((await request('/v2/media/setup')).status).toBe(200);
  expect((await request('/v2/media/setup',{action:'enable',sourceId:'source'})).status).toBe(200);expect(setups).toBe(2);
  expect((await request('/v2/media/setup',{action:'enable',sourceId:'source',restart:true})).status).toBe(400);
  expect((await request('/v2/media/cancel',{sourceId:'source',jobId:'x'.repeat(5000)})).status).toBe(413);
  expect([snapshots,cancels,setups,runtimes]).toEqual([1,1,2,0]);
});
test('media setup explains only trusted actionable errors and snapshot settings require no media collection',async()=>{
  let mediaReads=0,enabled=false,unexpected=false;
  const failure=async():Promise<never>=>{throw unexpected?new Error('/private/secret/token'):new MediaSetupError('Choose the ComfyUI installation to update.');};
  const server=createScopeServer('secret',{read:async()=>unread(1000),media:{get enabled(){return enabled;},snapshot:async()=>{mediaReads++;return{schemaVersion:1,sampledAtMs:1000,nextPollMs:2000,sources:[],jobs:[]};},cancel:async(sourceId,jobId)=>({schemaVersion:1,sourceId,jobId,status:'unsupported'})},mediaSetup:{status:failure,action:failure}});
  servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request=(path:string)=>fetch(origin+path,{headers:{Authorization:'Bearer secret'}});
  let response=await request('/v2/media/setup');expect(response.status).toBe(400);expect(await response.json()).toEqual({error:'setup_failed',message:'Choose the ComfyUI installation to update.'});
  unexpected=true;response=await request('/v2/media/setup');expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'service_unavailable'});
  expect((await(await request('/v2/snapshot')).json()).mediaEnabled).toBe(false);enabled=true;expect((await(await request('/v2/snapshot')).json()).mediaEnabled).toBe(true);expect(mediaReads).toBe(0);
});
test('runtime Connections metadata is authenticated, GET-only, and independent of observations',async()=>{
  let metadata=0,readings=0;const server=createScopeServer('secret',{read:async()=>{readings++;return unread(1000);},connections:async()=>{metadata++;return{schemaVersion:1,state:'ready',choices:[{id:'local',label:'Local',runtime:'omlx'}]};}});
  servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  expect((await fetch(origin+'/v2/connections')).status).toBe(401);expect(metadata).toBe(0);
  const request=(suffix='',method='GET')=>fetch(origin+'/v2/connections'+suffix,{method,headers:{Authorization:'Bearer secret'}});
  expect((await request('', 'POST')).status).toBe(405);expect((await request('?prompt=private')).status).toBe(400);
  expect(await(await request()).json()).toEqual({schemaVersion:1,state:'ready',choices:[{id:'local',label:'Local',runtime:'omlx'}]});expect([metadata,readings]).toEqual([1,0]);
});
