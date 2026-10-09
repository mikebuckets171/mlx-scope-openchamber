import { expect, test } from 'bun:test';
import type { HostClient } from '@openchamber/sdk';
import { chatKey } from '../../src/contract/chat-key.ts';
import type { MediaJobV1, MediaSnapshotV1 } from '../../src/contract/media.ts';
import { MediaController } from './controller.ts';
import { mediaJobView, orderedMediaJobs, jobOwnership } from './present.ts';
import { mediaMarkup, mediaGlanceMarkup } from './view.ts';
import { mediaSetupMarkup } from './setup.ts';

const job = (change: Partial<MediaJobV1> = {}): MediaJobV1 => ({ id: 'test-job', sourceId: 'comfy', kind: 'image', name: 'Image generation', state: 'running', phase: 'sampling', progress: { value: 8, total: 10, unit: 'steps', basis: 'phase' }, sampledAtMs: 20_000, observedAtMs: 19_900, progressAtMs: 18_000, startedAtMs: 10_000, freshness: 'live', ownership: {}, cancel: { supported: true }, ...change });
const snapshot = (jobs: MediaJobV1[] = [job()]): MediaSnapshotV1 => ({ schemaVersion: 1, sampledAtMs: 20_000, nextPollMs: 2_000, sources: [{ id: 'comfy', kind: 'comfyui', label: 'ComfyUI', state: 'ready', capabilities: { cancel: true, progress: true } }], jobs });
const model = (jobs: MediaJobV1[] = [job()]) => ({ snapshot: snapshot(jobs), error: null, stale: false, cancelling: new Set<string>(), confirm: null }) as unknown as MediaController;

test('current chat leads active jobs without claiming unassigned or project-only ownership', () => {
  const mine = job({ id: 'mine', ownership: { sessionKey: chatKey('session', 'one') } }), other = job({ id: 'other', ownership: { sessionKey: chatKey('session', 'two') } });
  expect(orderedMediaJobs(snapshot([other, job(), mine]), 'one').map(x => x.id)).toEqual(['mine', 'other', 'test-job']);
  expect(jobOwnership(mine, 'one')).toBe('This chat'); expect(jobOwnership(mine, 'two')).toBe('Other chat');
  expect(jobOwnership(job(), 'one')).toBe('Unassigned');
  expect(jobOwnership(job({ ownership: { projectKey: 'a'.repeat(64) } }), 'one')).toBe('Project · chat unassigned');
});
test('phase-local progress is labeled and preserves tile/block units', () => {
  const tile = job({ phase: 'encoding-references', kind: 'video', progress: { value: 80, total: 100, unit: 'tiles', basis: 'phase' } });
  const markup = mediaMarkup(model([tile]), null, 20_000).markup;
  expect(markup).toContain('80%'); expect(markup).toContain('phase progress'); expect(markup).toContain('80 / 100 tiles');
  expect(markup).toContain('Encoding references only'); expect(markup).not.toContain('diffusion steps'); expect(markup).not.toContain('ETA');
});
test('stale media retains only labeled phase counters; cancellation removes every percentage', () => {
  for (const v of [mediaJobView(job(), 20_000, true), mediaJobView(job({ freshness: 'stale' }), 20_000, false), mediaJobView(job(), 20_000, false, true)]) {
    expect(v.progress).toBeNull(); expect(v.canCancel).toBe(false);
  }
  const last = job({ freshness: 'stale', progress: null, lastProgress: { value: 4, total: 10, unit: 'tiles', basis: 'phase' }, lastProgressAtMs: 18_000 });
  expect(mediaJobView(last, 20_000, false)).toMatchObject({ percent: '40%', lastReported: true, moving: false });
  expect(mediaMarkup(model([last]), null, 20_000).markup).toContain('Last reported · ');
  expect(mediaMarkup(model([last]), null, 20_000).markup).toContain('data-mode="stale"');
  expect(mediaJobView(last, 20_000, false, true).fraction).toBeNull();
  expect(mediaJobView(job(), 20_000, false, true).fraction).toBeNull();
  expect(mediaJobView(job(), 90_000, false).elapsed).toBe('10 s'); // elapsed freezes at observation, never invented during disconnect
});
test('only fresh running work has an indeterminate ring; completed states never claim live progress', () => {
  const unknown = mediaMarkup(model([job({ progress: null })]), null, 20_000).markup;
  expect(unknown).toContain('progress unavailable'); expect(unknown).not.toContain('aria-valuenow');
  expect(unknown).toContain('data-mode="indeterminate"');
  for (const state of ['queued', 'waiting', 'cancelling'] as const) expect(mediaMarkup(model([job({ state, progress: null })]), null, 20_000).markup).toContain('data-mode="static"');
  const completed = mediaMarkup(model([job({ state: 'completed', phase: 'completed', freshness: 'last', finishedAtMs: 20_000 })]), null, 20_000).markup;
  expect(completed).not.toContain('role="progressbar"'); expect(completed).not.toContain('Cancel job');
});
test('percent-only counters appear once visually and stale glance retains job type, time, and update age', () => {
  const percent = job({ progress: { value: 40, total: 100, unit: 'percent', basis: 'phase' } });
  const markup = mediaMarkup(model([percent]), null, 20_000).markup;
  expect(markup).not.toContain('class="media-counters"');
  const last = job({ freshness: 'stale', progress: null, lastProgress: percent.progress, lastProgressAtMs: 18_000 });
  const glance = mediaGlanceMarkup(model([last]), null, 20_000, true);
  const text = typeof glance === 'string' ? glance : glance.markup;
  expect(text).toContain('Image · Sampling · last reported'); expect(text).toContain('Updated just now'); expect(text).toContain('10 s elapsed');
  expect(text).not.toContain('40% · Updated');
  expect(mediaJobView(last, 20_000, false).detail).toBeNull();
});
test('Session media is absent when idle and bounded to one active job plus other count', () => {
  expect(mediaGlanceMarkup(model([]), null, 20_000, true)).toBe('');
  const markup = mediaGlanceMarkup(model([job(), job({ id: 'second' }), job({ id: 'third' })]), null, 20_000, true);
  expect(typeof markup === 'string' ? markup : markup.markup).toContain('+2 other / unassigned');
  expect((typeof markup === 'string' ? markup : markup.markup).match(/role="progressbar"/g)).toHaveLength(1);
});
test('source, job, and helper messages are escaped; enable actions follow verified capability', () => {
  expect(mediaMarkup(model([job({ name: '<script>' })]), null, 20_000).markup).toContain('&lt;script&gt;');
  const markup = mediaSetupMarkup({ schemaVersion: 1, sources: [{ id: 'comfy', label: 'ComfyUI', state: 'pending', message: 'Installed · activates next time ComfyUI starts', canEnable: false, canDisable: true, managed: true, helperVersion: '3.1.0', runtimeVersion: '0.38.0', locations: [] }] }, false).markup;
  expect(markup).toContain('activates next time'); expect(markup).not.toContain('data-media-setup="enable"'); expect(markup).toContain('Disable and remove helper');
});
test('hidden frames perform no reads, and responses from before hiding cannot revive live progress', async () => {
  let calls = 0, finish!: (value: { status: number; body: string }) => void;
  const host = { serviceRequest: () => { calls++; return new Promise(resolve => { finish = resolve; }); } } as Pick<HostClient, 'serviceRequest'>;
  const controller = new MediaController(host, () => {}, () => 20_000);
  await controller.refresh(); expect(calls).toBe(0);
  controller.sync(true); const work = controller.refresh(); await Promise.resolve(); expect(calls).toBe(1);
  controller.sync(false); finish({ status: 200, body: JSON.stringify(snapshot()) }); await work;
  expect(controller.snapshot).toBeNull(); expect(controller.stale).toBe(true); controller.dispose();
});
test('cancellation requires confirmation and sends exact identity, then remains pending until acknowledged', async () => {
  const requests: Array<{ method: string; body?: string }> = [];
  const host = { serviceRequest: async (request: { method: string; body?: string }) => {
    requests.push(request); return { status: 200, body: JSON.stringify(request.method === 'POST' ? { schemaVersion: 1, sourceId: 'comfy', jobId: 'test-job', status: 'requested' } : snapshot()) };
  } } as Pick<HostClient, 'serviceRequest'>;
  const controller = new MediaController(host, () => {}, () => 20_000); controller.sync(true); await controller.refresh();
  await controller.cancel('comfy/test-job'); expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
  controller.requestCancel('comfy/test-job'); await controller.cancel('comfy/test-job');
  expect(JSON.parse(requests.find(r => r.method === 'POST')!.body!)).toEqual({ sourceId: 'comfy', jobId: 'test-job' });
  expect(controller.cancelling.has('comfy/test-job')).toBe(true); controller.dispose();
});
