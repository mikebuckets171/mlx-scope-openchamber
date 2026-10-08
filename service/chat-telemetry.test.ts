import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatTelemetry, type ChatTarget } from './chat-telemetry.ts';
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
const at = 100_000, writer = '00000000-2222-4333-8444-555555555555';
const target: ChatTarget = { sessionKey: 'a'.repeat(64), modelKey:'b'.repeat(64), providerKey:'c'.repeat(64), endpointKey:'d'.repeat(64) };
const measurement = { scope:'chat', basis:'estimated-characters', timingBasis:'delivery-window', phase:'generating', tokensPerSecond:42,
  observedAtMs:at, expiresAtMs:at+5_000, observation:{startedAtMs:at-3_000,endedAtMs:at}, freshness:'live' } as const;
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'scope-chat-'))); homes.push(home);
  const directory = join(home,'.cache','mlx-scope','chat-telemetry'); await mkdir(directory,{recursive:true,mode:0o700});
  const write = async (value: unknown, name = `${writer}.json`) => writeFile(join(directory,name), JSON.stringify(value),{mode:0o600});
  const body = { schemaVersion:1, writerID:writer, companionVersion:'3.0.0', protocol:'opencode-2.0.25', runtimeVersion:'2.0.25',
    updatedAtMs:at, expiresAtMs:at+15_000, entries:[{...target,measurement}] };
  return { home,directory,write,body };
}
test('selects one fresh endpoint-matched measurement and writes only hashed demand',async()=>{
  const f=await fixture(), telemetry=new ChatTelemetry(f.home,()=>at); await f.write(f.body);
  expect(await telemetry.observe('11111111',target)).toEqual(measurement);
  const demand=JSON.parse(await readFile(join(f.directory,'demand.json'),'utf8'));
  expect(demand.watched).toEqual([target]); expect(demand.expiresAtMs).toBe(at+15_000);
  await telemetry.dispose();
});
test('wrong endpoint, stale or future observations and unknown protocols have no speed',async()=>{
  const f=await fixture(), telemetry=new ChatTelemetry(f.home,()=>at);
  for (const body of [
    {...f.body,entries:[{...target,endpointKey:'e'.repeat(64),measurement}]},
    {...f.body,updatedAtMs:at+1}, {...f.body,expiresAtMs:at}, {...f.body,protocol:'future'}, {...f.body,companionVersion:'2.1.6'},
    {...f.body,entries:[{...target,measurement:{...measurement,expiresAtMs:at}}]},
  ]) { await f.write(body); expect(await telemetry.observe('11111111',target)).toBeNull(); }
  await telemetry.dispose();
});
test('multiple matching writers never double count; extra fields never escape to the snapshot',async()=>{
  const f=await fixture(), telemetry=new ChatTelemetry(f.home,()=>at), other='00000000-3333-4333-8444-555555555555';
  await f.write({...f.body,entries:[{...target,measurement:{...measurement,content:'private'}}]});
  expect(await telemetry.observe('11111111',target)).toEqual(measurement);
  await f.write({...f.body,writerID:other},`${other}.json`);
  expect(await telemetry.observe('11111111',target)).toBeNull(); await telemetry.dispose();
});
test('frame switching removes demand and expired frames are pruned while another view stays open',async()=>{
  const f=await fixture(); let now=at; const telemetry=new ChatTelemetry(f.home,()=>now);
  await telemetry.observe('11111111',target);
  now+=16_000; const next={...target,sessionKey:'e'.repeat(64)}; await telemetry.observe('22222222',next);
  expect(JSON.parse(await readFile(join(f.directory,'demand.json'),'utf8')).watched).toEqual([next]);
  await telemetry.observe('22222222',null);
  await expect(readFile(join(f.directory,'demand.json'))).rejects.toThrow(); await telemetry.dispose();
});
test('symlink writers and oversized files are ignored',async()=>{
  const f=await fixture(), telemetry=new ChatTelemetry(f.home,()=>at);
  await f.write(f.body,'outside.json'); await symlink(join(f.directory,'outside.json'),join(f.directory,`${writer}.json`));
  expect(await telemetry.observe('11111111',target)).toBeNull();
  await rm(join(f.directory,`${writer}.json`)); await writeFile(join(f.directory,`${writer}.json`),'x'.repeat(65_537),{mode:0o600});
  expect(await telemetry.observe('11111111',target)).toBeNull(); await telemetry.dispose();
});
test('an uninstalled companion does not create a cache or background demand',async()=>{
  const f=await fixture(); await rm(f.directory,{recursive:true}); const telemetry=new ChatTelemetry(f.home,()=>at);
  expect(await telemetry.observe('11111111',target)).toBeNull(); await expect(readFile(join(f.directory,'demand.json'))).rejects.toThrow();
  await telemetry.dispose();
});

test('expired crash files do not exhaust the fresh writer limit',async()=>{
  const f=await fixture(), telemetry=new ChatTelemetry(f.home,()=>at);
  for(let i=0;i<24;i++) {
    const id=`${i.toString(16).padStart(8,'0')}-2222-4333-8444-000000000000`;
    await f.write({...f.body,writerID:id,expiresAtMs:at-1},`${id}.json`);
  }
  await f.write(f.body);
  expect(await telemetry.observe('11111111',target)).toEqual(measurement);
  await telemetry.dispose();
});
