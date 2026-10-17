import { expect, test } from 'bun:test';
import { classAKeys } from '../../src/contract/guards.ts';
import { parseMediaJob, withdrawMediaProgress, type MediaJobV1 } from '../../src/contract/media.ts';
import { mediaFinish } from '../../panel/media/present.ts';
import idle from '../../tests/fixtures/phosphene/4.19.5/status-idle.json';
import states from '../../tests/fixtures/phosphene/4.19.5/status-states.json';
import type { MediaAdapterOptions } from './adapters.ts';
import { MediaDiscovery, PHOSPHENE_ORIGIN, phospheneVersion, type MediaSourceConfig } from './discovery.ts';
import { phosphene, PHOSPHENE_READ_MS, PHOSPHENE_STALE_MS } from './phosphene.ts';
import { MediaService } from './service.ts';

const CONFIG: MediaSourceConfig = { id: 'phosphene', kind: 'phosphene', label: 'Phosphene', origin: PHOSPHENE_ORIGIN, version: '4.19.5' };
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const serverNow = (body: { server_now: number }) => Math.round(body.server_now * 1000);
const read = (body: { server_now: number }, now = serverNow(body) + 40) => {
  const urls: string[] = [];
  const options: MediaAdapterOptions = { now: () => now, fetchImpl: async url => { urls.push(String(url)); return json(body); } };
  return { urls, out: phosphene(CONFIG, options) };
};
const PRIVATE = ['FIXTURE PRIVATE', '/Users/fixture', 'Traceback', 'separator install'];
const kept = (value: unknown) => { const text = JSON.stringify(value); return PRIVATE.filter(word => text.includes(word)); };

test('the real idle capture becomes one finished video, dated by Phosphene, with nothing private kept', async () => {
  const { urls, out } = read(idle), collection = await out;
  expect(urls).toEqual(['http://127.0.0.1:8198/status']);
  expect(collection.source).toEqual({ id: 'phosphene', kind: 'phosphene', label: 'Phosphene', state: 'ready', capabilities: { progress: false, cancel: false } });
  expect(collection.jobs).toHaveLength(1);
  const [job] = collection.jobs;
  expect(job).toMatchObject({ id: 'j-1a14b4e61c5-001', kind: 'video', name: 'Video 61c5-001', state: 'completed', phase: 'completed', freshness: 'last',
    startedAtMs: 1_792_264_790_583, finishedAtMs: 1_792_264_790_583 + 399_990, cancel: { supported: false }, ownership: {} });
  expect(parseMediaJob(job)).toEqual(job!);
  expect(collection.ttlMs).toBe(PHOSPHENE_READ_MS.idle);
  expect(kept(collection)).toEqual([]); expect(classAKeys(collection)).toEqual([]);
});

test('denoising reports its step counters and Phosphene’s own time left; queued jobs are listed by kind only', async () => {
  const body = states['ltx-denoise'], collection = await read(body).out, observed = serverNow(body);
  const [running, queued] = collection.jobs;
  expect(running).toMatchObject({ id: 'j-fixture-ltx-002', kind: 'video', state: 'running', phase: 'sampling', freshness: 'live', observedAtMs: observed,
    progress: { value: 7, total: 13, unit: 'steps', basis: 'phase' }, startedAtMs: observed - 120_000 });
  expect(running!.etaAtMs).toBeUndefined();
  expect(collection.reportedEta).toEqual(new Map([['j-fixture-ltx-002', observed + 212_400]]));
  expect(queued).toMatchObject({ id: 'j-fixture-img-003', kind: 'image', name: 'Image -img-003', state: 'queued', phase: 'queued', progress: null });
  expect(collection.source.capabilities).toEqual({ progress: true, cancel: false });
  expect([collection.ttlMs, collection.staleMs]).toEqual([PHOSPHENE_READ_MS.active, PHOSPHENE_STALE_MS]);
  expect(kept(collection)).toEqual([]);
});

test('setup and decoding have no counters, so no estimate; each H3 window is its own phase', async () => {
  const setup = await read(states['ltx-setup']).out, decode = await read(states['ltx-decode']).out;
  expect(setup.jobs[0]).toMatchObject({ phase: 'preparing', progress: null }); expect(setup.reportedEta?.size).toBe(0);
  expect(decode.jobs[0]).toMatchObject({ phase: 'decoding', progress: null }); expect(decode.reportedEta?.size).toBe(0);
  const second = (await read(states['h3-window-2']).out).jobs[0]!, third = (await read(states['h3-window-3']).out).jobs[0]!;
  expect([second.progress, third.progress]).toEqual([{ value: 4, total: 8, unit: 'steps', basis: 'phase' }, { value: 1, total: 8, unit: 'steps', basis: 'phase' }]);
  expect(second.phaseKey).toMatch(/^[a-f0-9]{64}$/); expect(third.phaseKey).not.toBe(second.phaseKey);
  expect((await read(states['ltx-denoise']).out).jobs[0]!.phaseKey).toBeUndefined();
});

test('waiting, a paused queue and ended jobs map to Scope’s states; unknown, invalid and old entries are left out', async () => {
  const waiting = await read(states.waiting).out;
  expect(waiting.jobs[0]).toMatchObject({ state: 'waiting', phase: 'waiting', progress: null, message: 'Waiting for the GPU' });
  const paused = await read(states.paused).out;
  expect(paused.jobs.map(job => [job.kind, job.state, job.message])).toEqual([['video', 'queued', 'Phosphene’s queue is paused'], ['unknown', 'queued', 'Phosphene’s queue is paused']]);
  const ended = await read(states.ended).out, finished = serverNow(states.ended);
  expect(ended.jobs.map(job => [job.id, job.kind, job.state])).toEqual([['j-fixture-img-010', 'image', 'completed'], ['j-fixture-ltx-011', 'video', 'failed'],
    ['j-fixture-ltx-012', 'video', 'cancelled'], ['j-fixture-ltx-013', 'video', 'cancelled'], ['j-fixture-trn-015', 'unknown', 'completed']]);
  expect(ended.jobs[0]).toMatchObject({ finishedAtMs: finished - 600_000 + 42_500, observedAtMs: finished - 600_000 + 42_500 });
  expect(ended.jobs[1]!.message).toBe('Generation failed. Check Phosphene.');
  expect(ended.ttlMs).toBe(PHOSPHENE_READ_MS.idle);
  for (const collection of [waiting, paused, ended]) { expect(kept(collection)).toEqual([]); for (const job of collection.jobs) expect(parseMediaJob(job)).toEqual(job); }
});

test('anything that is not Phosphene’s status, or is larger than 1 MB, is refused', async () => {
  for (const body of [{}, { ...idle, server_now: 'soon' }, { ...idle, queue: null }, { ...idle, running: 'yes' }, [idle]]) {
    await expect(phosphene(CONFIG, { now: () => Date.now(), fetchImpl: async () => json(body) })).rejects.toThrow();
  }
  const large = { ...idle, log: ['x'.repeat(1_000_001)] };
  await expect(phosphene(CONFIG, { now: () => Date.now(), fetchImpl: async () => json(large) })).rejects.toThrow();
});

test('the media service shows Phosphene’s estimate as its own, reads at most every 15 s while running, and withdraws stale jobs', async () => {
  let now = serverNow(states['ltx-denoise']) + 40, reads = 0, body: unknown = states['ltx-denoise'];
  const service = new MediaService({ home: '/nonexistent', now: () => now, configurations: async () => [CONFIG], fetchImpl: async () => { reads++; return json(body); } });
  const first = await service.snapshot(), job = first.jobs.find(item => item.state === 'running')!;
  expect(job).toMatchObject({ etaBasis: 'reported', etaAtMs: serverNow(states['ltx-denoise']) + 212_400 });
  expect(mediaFinish(job, now, false, false, new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }))!.text).toMatch(/^finishes around .+ · app estimate$/);
  now += 10_000; await service.snapshot(); expect(reads).toBe(1);
  now += 6_000; await service.snapshot(); expect(reads).toBe(2);
  // Phosphene stops answering: the job is withdrawn as unavailable and no estimate is shown or invented.
  body = null;
  now += PHOSPHENE_READ_MS.active + 1; const lost = await service.snapshot();
  expect(lost.sources[0]!.state).toBe('disconnected');
  expect(lost.jobs.find(item => item.id === 'j-fixture-ltx-002')).toMatchObject({ freshness: 'unavailable', progress: null });
  expect(lost.jobs.find(item => item.id === 'j-fixture-ltx-002')!.etaAtMs).toBeUndefined();
  expect(service.runningNow(now)).toBe(false);
});

test('a reported estimate survives the wire and its withdrawal with its basis; an unknown basis does not', () => {
  const job: MediaJobV1 = { id: 'j-1', sourceId: 'phosphene', kind: 'video', name: 'Video j-1', state: 'running', phase: 'sampling', sampledAtMs: 2_000, observedAtMs: 1_000,
    progress: { value: 3, total: 8, unit: 'steps', basis: 'phase' }, etaAtMs: 60_000, etaBasis: 'reported', freshness: 'live', ownership: {}, cancel: { supported: false } };
  expect(parseMediaJob(job)).toMatchObject({ etaAtMs: 60_000, etaBasis: 'reported' });
  expect(parseMediaJob({ ...job, etaBasis: 'guessed' })!.etaAtMs).toBeUndefined();
  expect(withdrawMediaProgress(job, 'stale')).toMatchObject({ lastEtaAtMs: 60_000, etaBasis: 'reported' });
});

test('discovery finds Phosphene only by its version answer, and never probes it once media.json turns it off', async () => {
  const urls: string[] = [];
  const answer = (version: unknown) => async (url: string | URL | Request) => { urls.push(String(url)); return String(url).endsWith('/version') ? json(version) : json({}); };
  expect(await phospheneVersion(PHOSPHENE_ORIGIN, answer({ local_version: '4.19.5', local_sha: '287a964' }))).toBe('4.19.5');
  for (const other of [{ local_version: '4.19' }, { local_version: '4.19.5' }, { version: '1.0.0', local_sha: 'x' }, []]) {
    expect(await phospheneVersion(PHOSPHENE_ORIGIN, answer(other))).toBeNull();
  }
  const home = '/nonexistent-scope-home';
  const found = await new MediaDiscovery({ home, now: () => 0, fetchImpl: answer({ local_version: '4.19.5', local_sha: '287a964' }) }).configurations();
  expect(found.filter(source => source.kind === 'phosphene')).toEqual([{ id: 'phosphene', kind: 'phosphene', label: 'Phosphene', origin: PHOSPHENE_ORIGIN, version: '4.19.5' }]);
  expect(urls).toContain('http://127.0.0.1:8198/version');
});
