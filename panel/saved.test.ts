import { expect, test } from 'bun:test';
import type { HostClient } from '@openchamber/sdk';
import { parseTelemetrySnapshot } from '../src/telemetry.ts';
import { SAVED_KEY, SAVED_LIMIT, SavedObservations, sanitizeObservation, snapshotObservation, observationReport } from './saved.ts';

const observation = (now = 1000) => snapshotObservation(parseTelemetrySnapshot({ available:true, runtime:'omlx', phase:'prefill',
  sampledAt:now, activeRequests:1, prefillProgress:.99999, prefillProcessedTokens:99999, prefillTotalTokens:100000,
  modelID:'private-model', message:'private-path', traceEpoch:123, prefillETASeconds:4 }), false, null, now);
const storage = () => {
  const values = new Map<string, unknown>();
  const host = { keys:async () => [...values.keys()], delete:async (key:string) => { values.delete(key); }, get: async (key: string) => values.get(key), set: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); } };
  return { values, host: host as HostClient['storage'] };
};
test('saved observations rebuild a numeric allowlist and never retain runtime identity or arbitrary strings', () => {
  const item = observation();
  const clean = sanitizeObservation({ ...item, model:'private-model', request_id:'private-request', measurements:{...item.measurements, token:'private-key', cpu:Infinity, memory:-1} })!;
  const text = JSON.stringify(clean);
  expect(text).not.toMatch(/private|request_id|traceEpoch|Infinity/);
  expect(clean.measurements.cpu).toBeNull(); expect(clean.measurements.memory).toBeNull();
  expect(observationReport(clean)).toContain('Prefill remaining: <1 %');
  expect(observationReport(clean)).not.toContain('private');
  expect(sanitizeObservation({...item, savedAt:9e15})).toBeNull();
  expect(sanitizeObservation({...item, phase:'private-text'})).toBeNull();
});
test('saved observations retain twelve newest manual saves and leave unrelated storage alone', async () => {
  const {host, values} = storage(), saved = new SavedObservations(host);
  await Promise.all(Array.from({length:SAVED_LIMIT}, (_, i) => saved.save(observation(1000+i))));
  expect(saved.items).toHaveLength(SAVED_LIMIT);
  await saved.save(observation(2000)); expect(saved.items).toHaveLength(SAVED_LIMIT);
  expect(saved.items.some(item => item.savedAt === 1000)).toBe(false);
  const reloaded = new SavedObservations(host); await reloaded.load();
  expect(reloaded.items).toHaveLength(SAVED_LIMIT);
  expect(JSON.stringify([...values.values()]).length).toBeLessThan(64*1024);
  await saved.delete(saved.items[0]!); expect(saved.items).toHaveLength(SAVED_LIMIT-1);
  await saved.clear(); expect(saved.items).toEqual([]);
  expect([...values.keys()]).toEqual([]);
});
test('storage errors preserve the confirmed state and later writes recover', async () => {
  const {host} = storage(); let fail = false;
  const saved = new SavedObservations({...host, delete:async key => { if(fail) throw new Error('unavailable'); await host.delete(key); }, set:async (key,value) => { if(fail) throw new Error('unavailable'); await host.set(key,value); }});
  await saved.save(observation()); fail=true;
  await expect(saved.clear()).rejects.toThrow(); expect(saved.items).toHaveLength(1);
  await expect(saved.save(observation(2000))).rejects.toThrow(); expect(saved.items).toHaveLength(1);
  fail=false; await saved.save(observation(3000)); expect(saved.items).toHaveLength(2);
});
test('malformed stored data stays bounded and cannot inject strings into reports', async () => {
  const {host,values} = storage(); values.set(SAVED_KEY+'001',null); values.set(SAVED_KEY+'002',{...observation(),measurements:{cpu:'secret'}});
  for(let i=3;i<20;i++) values.set(SAVED_KEY+String(i).padStart(3,'0'), observation(i*1000));
  const saved = new SavedObservations(host); await saved.load();
  expect(saved.items.length).toBeLessThanOrEqual(SAVED_LIMIT);
  expect(JSON.stringify(saved.items)).not.toContain('secret');
  await saved.clear(); values.set(SAVED_KEY+'001',{kind:'invalid'}); await saved.load(); expect(saved.items).toEqual([]);
});
test('held prefill omits the stage estimate and preserves missing telemetry', () => {
  const snapshot = parseTelemetrySnapshot({ available:true, runtime:'omlx',phase:'prefill',sampledAt:1000,activeRequests:1,prefillETASeconds:9,prefillProgress:.5 });
  const saved = snapshotObservation(snapshot,true,null,2000);
  expect(saved.state).toBe('held'); expect(saved.measurements.stageEstimate).toBeNull();
  expect(saved.measurements.cpu).toBeNull(); expect(saved.measurements.processed).toBeNull();
});

test('two views save concurrently without overwriting either acknowledged observation', async () => {
  const {host,values} = storage(); values.set('view.compact',true);
  const a=new SavedObservations(host), b=new SavedObservations(host);
  await Promise.all([a.save(observation(1000)),b.save(observation(2000))]);
  await a.load(); expect(a.items.map(item=>item.savedAt)).toEqual([2000,1000]);
  await Promise.all(Array.from({length:14},(_,i)=>new SavedObservations(host).save(observation(3000+i))));
  await a.load(); expect(a.items).toHaveLength(12);
  expect([...values.keys()].filter(key=>key.startsWith(SAVED_KEY))).toHaveLength(12);
  await a.clear(); expect(values.get('view.compact')).toBe(true);
});
test('same-time saves remain distinct when secure-context randomUUID is unavailable', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', {value:undefined, configurable:true});
  try {
    const {host,values} = storage(), a = new SavedObservations(host), b = new SavedObservations(host);
    const first = observation(), second = observation();
    first.measurements.cpu = 11; second.measurements.cpu = 22;
    await Promise.all([a.save(first), b.save(second)]);
    const reloaded = new SavedObservations(host); await reloaded.load();
    expect(values.size).toBe(2);
    expect(reloaded.items.map(item => item.measurements.cpu).sort()).toEqual([11,22]);
  } finally {
    if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor);
    else Reflect.deleteProperty(crypto, 'randomUUID');
  }
});
test('saved snapshot withholds native readings beyond the live display freshness boundary', () => {
  const snapshot = parseTelemetrySnapshot({available:true,runtime:'omlx',phase:'idle',sampledAt:100000,
    system:{platform:'darwin',sampledAt:100000,cpuPercent:12,macOS:{sampledAt:1000,swapUsedGB:2}}});
  const saved=snapshotObservation(snapshot,false,null,100000);
  expect(saved.measurements.swap).toBeNull(); expect(saved.measurements.cpu).toBe(12);
});
test('comparison reports preserve each reference timestamp and partial status', () => {
  const saved = sanitizeObservation({...observation(),kind:'comparison',state:'finished',reference:{observedGeneration:20},referenceSampledAt:500,referenceState:'interrupted'})!;
  expect(observationReport(saved)).toContain('1970-01-01T00:00:00.500Z · interrupted');
  const old = sanitizeObservation({...saved,referenceState:undefined,referenceSampledAt:undefined})!;
  expect(observationReport(old)).toContain('time not recorded · status not recorded');
});
