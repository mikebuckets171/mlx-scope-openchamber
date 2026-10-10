import { expect, test } from 'bun:test';
import { parseMediaJob, parseMediaProgress, parseMediaSnapshot, type MediaJobV1 } from './media.ts';

const job: MediaJobV1 = { id: 'job1', sourceId: 'comfy', kind: 'image', name: 'Image', state: 'running', phase: 'sampling', progress: { value: 8, total: 10, unit: 'steps', basis: 'phase' }, sampledAtMs: 1000, observedAtMs: 1000, freshness: 'live', ownership: { sessionKey: 'a'.repeat(64) }, cancel: { supported: true } };
test('media counters preserve units and reject invented or malformed measurements', () => {
  for (const unit of ['steps', 'blocks', 'tiles', 'frames', 'units', 'percent'] as const) expect(parseMediaProgress({ value: 2, total: unit === 'percent' ? 100 : 10, unit, basis: 'phase' })?.unit).toBe(unit);
  expect(parseMediaProgress({value:30.5,total:100,unit:'percent',basis:'phase'})?.value).toBe(30.5);
  for (const invalid of [{ value: -1 }, { value: 11 }, { value: 0.2 }, { total: 0 }, { total: Infinity }, { basis: 'job' }, { unit: 'seconds' }])
    expect(parseMediaProgress({ value: 2, total: 10, unit: 'units', basis: 'phase', ...invalid })).toBeNull();
});
test('media parser withdraws stale progress and scoped cancellation', () => {
  expect(parseMediaJob(job)).toEqual(job);
  const stale = parseMediaJob({ ...job, freshness: 'stale', prompt: 'do not expose' });
  expect(stale?.progress).toBeNull(); expect(stale?.cancel.supported).toBe(false); expect(stale).not.toHaveProperty('prompt');
  expect(parseMediaJob({ ...job, observedAtMs: 1001 })).toBeNull();
  expect(parseMediaJob({ ...job, state: 'completed' })).toBeNull();
  expect(parseMediaJob({ ...job, state: 'completed', phase: 'completed', freshness: 'last' })?.progress).toBeNull();
});
test('media parser requires a matching source and bounds both arrays', () => {
  const source = { id: 'comfy', kind: 'comfyui', label: 'ComfyUI', state: 'ready', capabilities: { progress: true, cancel: true } };
  expect(parseMediaSnapshot({ schemaVersion: 1, sampledAtMs: 1000, nextPollMs: 2000, sources: [source], jobs: Array(100).fill(job) })?.jobs).toHaveLength(64);
  expect(parseMediaSnapshot({ schemaVersion: 1, sampledAtMs: 1000, nextPollMs: 2000, sources: [], jobs: [job] })?.jobs).toHaveLength(0);
  expect(parseMediaSnapshot({ schemaVersion: 2 })).toBeNull();
});
test('last reported progress is a strict historical field and cannot become a live or terminal value',()=>{
  const historical={...job,freshness:'stale',progress:null,lastProgress:job.progress,lastProgressAtMs:900};
  expect(parseMediaJob(historical)?.lastProgress).toEqual(job.progress);expect(parseMediaJob(historical)?.progress).toBeNull();expect(parseMediaJob(historical)?.cancel.supported).toBe(false);
  for(const change of [{freshness:'live'},{state:'cancelling'},{state:'waiting',phase:'waiting'},{state:'completed',phase:'completed',freshness:'last'},{lastProgressAtMs:1001},{lastProgressAtMs:undefined},{lastProgress:{value:11,total:10,unit:'steps',basis:'phase'}}])
    expect(parseMediaJob({...historical,...change})?.lastProgress).toBeUndefined();
});
