import { expect, test } from 'bun:test';
import type { HostClient } from '@openchamber/sdk';
import { chatKey } from '../../src/contract/chat-key.ts';
import type { MediaJobV1, MediaSnapshotV1 } from '../../src/contract/media.ts';
import { MediaController } from './controller.ts';
import { mediaFinish, mediaJobView, orderedMediaJobs, jobOwnership } from './present.ts';
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
  for (const state of ['queued', 'waiting'] as const) expect(mediaMarkup(model([job({ state, progress: null })]), null, 20_000).markup).toContain('data-mode="static"');
  expect(mediaMarkup(model([job({ state: 'cancelling', progress: null })]), null, 20_000).markup).toContain('data-mode="draining"');
  const completed = mediaMarkup(model([job({ state: 'completed', phase: 'completed', freshness: 'last', finishedAtMs: 20_000 })]), null, 20_000).markup;
  expect(completed).not.toContain('role="progressbar"'); expect(completed).not.toContain('Cancel job');
  // Completion holds a full, dimmed ring that is decoration only; failed and cancelled jobs show none.
  expect(completed).toContain('data-mode="done" aria-hidden="true"'); expect(completed).toContain('stroke-dashoffset:0');
  for (const state of ['failed', 'cancelled'] as const) expect(mediaMarkup(model([job({ state, phase: state, freshness: 'last', progress: null })]), null, 20_000).markup).not.toContain('media-ring');
});
const ringText = (markup: string): string[] => [...markup.matchAll(/<div class="media-ring"[^>]*>([\s\S]*?)<\/svg><\/div>/g)].map(match => match[1]!.replace(/<[^>]+>/g, '').trim());
test('the ring never displays a number: the percentage is text beside it in the card and the glance', () => {
  const live = job(), last = job({ freshness: 'stale', progress: null, lastProgress: { value: 4, total: 10, unit: 'tiles', basis: 'phase' }, lastProgressAtMs: 18_000 });
  for (const value of [live, last, job({ progress: { value: 40, total: 100, unit: 'percent', basis: 'phase' } }), job({ progress: null })]) {
    const card = mediaMarkup(model([value]), null, 20_000).markup, glance = mediaGlanceMarkup(model([value]), null, 20_000, true);
    const text = typeof glance === 'string' ? glance : glance.markup;
    expect(card).not.toContain('media-ring-value'); expect(text).not.toContain('media-ring-value');
    expect(ringText(card)).toEqual(['']); expect(ringText(text)).toEqual(['']);
  }
  const card = mediaMarkup(model([live]), null, 20_000).markup;
  expect(card).toContain('<p class="media-phase">Sampling · <span class="media-percent">80%</span><small>phase progress</small></p>');
  expect(card).toContain('<p class="media-counters">8 / 10 steps</p>');
  // The accessible name and value stay on the ring itself.
  expect(card).toContain('aria-label="Sampling progress · this phase only"'); expect(card).toContain('aria-valuenow="80"');
  expect(card).toContain('aria-valuetext="80% · 8 / 10 steps · Sampling only"');
  const glance = mediaGlanceMarkup(model([live]), null, 20_000, true);
  expect(typeof glance === 'string' ? glance : glance.markup).toContain('Image · <span class="media-percent">80%</span> phase progress');
  expect(mediaMarkup(model([last]), null, 20_000).markup).toContain('Last reported · Sampling · <span class="media-percent">40%</span>');
});
test('indeterminate rings are still and empty; a confirmed cancellation drains the same ring in place', () => {
  const unknown = mediaMarkup(model([job({ progress: null })]), null, 20_000).markup;
  expect(unknown).toContain('data-mode="indeterminate"'); expect(unknown).toContain('stroke-dashoffset:100');
  const key = (markup: string) => /<div class="media-ring" data-key="([^"]+)"/.exec(markup)?.[1];
  const live = mediaMarkup(model([job()]), null, 20_000).markup, controller = model([job()]);
  controller.cancelling.add('comfy/test-job');
  const draining = mediaMarkup(controller, null, 20_000).markup;
  expect(key(draining)).toBe(key(live)); expect(draining).toContain('data-mode="draining"'); expect(draining).toContain('stroke-dashoffset:100');
  expect(draining).not.toContain('aria-valuenow'); expect(draining).not.toContain('media-percent');
  // A stale job keeps its ring identity; a new phase, node or counter unit replaces it.
  expect(key(mediaMarkup(model([job({ freshness: 'stale', progress: null, lastProgress: job().progress, lastProgressAtMs: 18_000 })]), null, 20_000).markup)).toBe(key(live));
  for (const change of [{ phase: 'decoding' as const }, { phaseKey: 'b'.repeat(64) }, { progress: { value: 8, total: 10, unit: 'tiles' as const, basis: 'phase' as const } }])
    expect(key(mediaMarkup(model([job(change)]), null, 20_000).markup)).not.toBe(key(live));
});
const NOW = Date.UTC(2026, 9, 10, 21, 40, 15), CLOCK = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
const at = (change: Partial<MediaJobV1>): MediaJobV1 => job({ sampledAtMs: NOW, observedAtMs: NOW - 1_000, progressAtMs: NOW - 2_000, startedAtMs: NOW - 120_000, ...change });
test('a live estimate is clock time rounded up to the minute, "any moment" inside a minute, and omitted once overdue', () => {
  const finish = (etaAtMs: number, now = NOW) => mediaFinish(at({ etaAtMs, etaBasis: 'measured-window' }), now, false, false, CLOCK);
  expect(finish(NOW + 310_000)).toEqual({ text: 'finishes around 21:46', basis: 'live' }); // 21:45:25 rounds up
  expect(finish(Date.UTC(2026, 9, 10, 21, 45, 0))?.text).toBe('finishes around 21:45'); // already a whole minute
  expect(finish(Date.UTC(2026, 9, 10, 21, 45, 0, 1))?.text).toBe('finishes around 21:46');
  expect(finish(NOW + 60_000)?.text).toBe('finishes around 21:42');
  expect(finish(NOW + 59_999)?.text).toBe('finishes any moment');
  expect(finish(NOW - 60_000)?.text).toBe('finishes any moment');
  expect(finish(NOW - 60_001)).toBeNull();
  // Presenters are pure: the same estimate reads differently only because `now` moved.
  expect(finish(NOW + 310_000, NOW + 300_000)?.text).toBe('finishes any moment');
});
test('held, measured and absent finish times', () => {
  const held = at({ freshness: 'stale', progress: null, lastProgress: job().progress, lastProgressAtMs: NOW - 30_000, lastEtaAtMs: NOW + 200_000, etaBasis: 'measured-window', cancel: { supported: false } });
  expect(mediaFinish(held, NOW, false, false, CLOCK)).toEqual({ text: 'last estimate · around 21:44', basis: 'held' });
  expect(mediaFinish({ ...held, lastEtaAtMs: NOW - 600_000 }, NOW, false, false, CLOCK)?.text).toBe('last estimate · around 21:31');
  // A lost Scope response holds the last live estimate rather than presenting it as live.
  expect(mediaFinish(at({ etaAtMs: NOW + 200_000, etaBasis: 'measured-window' }), NOW, true, false, CLOCK)).toEqual({ text: 'last estimate · around 21:44', basis: 'held' });
  const finished = at({ state: 'completed', phase: 'completed', freshness: 'last', progress: null, finishedAtMs: Date.UTC(2026, 9, 10, 21, 38, 40) });
  expect(mediaFinish(finished, NOW, false, false, CLOCK)).toEqual({ text: 'finished 21:38', basis: 'measured' });
  expect(mediaFinish(finished, NOW, true, false, CLOCK)?.text).toBe('finished 21:38');
  for (const absent of [at({}), at({ etaAtMs: NOW + 200_000, etaBasis: 'measured-window', progress: null }), { ...held, lastEtaAtMs: undefined },
    at({ state: 'completed', phase: 'completed', freshness: 'last', progress: null }), at({ state: 'failed', phase: 'failed', freshness: 'last', progress: null, finishedAtMs: NOW }),
    at({ state: 'cancelled', phase: 'cancelled', freshness: 'last', progress: null, finishedAtMs: NOW }), at({ state: 'cancelling', progress: null, etaAtMs: NOW + 200_000 }),
    at({ state: 'queued', phase: 'queued', progress: null }), at({ state: 'waiting', phase: 'waiting', progress: null })])
    expect(mediaFinish(absent, NOW, false, false, CLOCK)).toBeNull();
  expect(mediaFinish(at({ etaAtMs: NOW + 200_000, etaBasis: 'measured-window' }), NOW, false, true, CLOCK)).toBeNull(); // cancellation withdraws it
  expect(mediaJobView(at({ etaAtMs: NOW + 310_000, etaBasis: 'measured-window' }), NOW, false, false, CLOCK).finish?.text).toBe('finishes around 21:46');
});
test('finish lines render under the job detail; the glance adds only a live estimate', () => {
  const live = at({ etaAtMs: NOW + 310_000, etaBasis: 'measured-window' });
  const card = mediaMarkup(model([live]), null, NOW).markup;
  expect(card).toMatch(/<p class="media-timing">[^<]+ elapsed<\/p><p class="media-finish" data-basis="live">finishes around [^<]+<\/p><\/div>/);
  const glance = (value: MediaJobV1) => { const out = mediaGlanceMarkup(model([value]), null, NOW, true); return typeof out === 'string' ? out : out.markup; };
  expect(glance(live)).toMatch(/<span class="media-glance-finish">finishes around [^<]+<\/span>/);
  const held = at({ freshness: 'stale', progress: null, lastProgress: job().progress, lastProgressAtMs: NOW - 30_000, lastEtaAtMs: NOW + 200_000, etaBasis: 'measured-window', cancel: { supported: false } });
  expect(mediaMarkup(model([held]), null, NOW).markup).toMatch(/<p class="media-finish" data-basis="held">last estimate · around [^<]+<\/p>/);
  expect(glance(held)).not.toContain('estimate'); expect(glance(held)).not.toContain('finishes');
  const done = mediaMarkup(model([at({ state: 'completed', phase: 'completed', freshness: 'last', progress: null, finishedAtMs: NOW - 90_000 })]), null, NOW).markup;
  expect(done).toMatch(/<p class="media-finish" data-basis="measured">finished [^<]+<\/p>/);
  for (const absent of [at({}), at({ etaAtMs: NOW - 120_000, etaBasis: 'measured-window' })]) {
    expect(mediaMarkup(model([absent]), null, NOW).markup).not.toContain('media-finish'); expect(glance(absent)).not.toContain('finish');
  }
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
