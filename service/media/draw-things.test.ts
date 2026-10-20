import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMediaJob } from '../../src/contract/media.ts';
import { lsofDrawThingsArgv, type Argv } from '../lib/argv.ts';
import { mediaConfigPath, MediaDiscovery, drawThingsInstalled, type MediaSourceConfig } from './discovery.ts';
import { drawThings, DRAW_THINGS_READ_MS, parseDrawThingsLog, parseDrawThingsLsof } from './draw-things.ts';

const FIXTURES = join(import.meta.dir, '../../tests/fixtures/draw-things/26.10');
const fixture = (name: string) => readFile(join(FIXTURES, name), 'utf8');
const PRIVATE = ['/Users/fixture', 'FIXTURE PRIVATE', 'Models', '.log'];
const kept = (value: unknown) => { const text = JSON.stringify(value); return PRIVATE.filter(word => text.includes(word)); };
let sources = 0;
const config = (): MediaSourceConfig => ({ id: `draw-things-${++sources}`, kind: 'draw-things', label: 'Draw Things' });

test('the real logs give their phase, step counters, sampling passes and whether the render finished', async () => {
  expect(parseDrawThingsLog(await fixture('video-completed.log'))).toEqual({ phase: 'finishing', step: null, total: null, passes: 1, generated: true, kind: 'video' });
  expect(parseDrawThingsLog(await fixture('image-completed.log'))).toMatchObject({ generated: true, kind: 'image', passes: 1 });
  expect(parseDrawThingsLog(await fixture('image-stopped.log'))).toEqual({ phase: 'sampling', step: 32, total: 40, passes: 1, generated: false, kind: 'unknown' });
  // A counter that starts again is a new sampling pass, so a phase-local estimate is never stitched across them.
  expect(parseDrawThingsLog('Sampling... 8 / 8\rSampling... 1 / 4\rSampling... 2 / 4\r')).toMatchObject({ step: 2, total: 4, passes: 2 });
  expect(parseDrawThingsLog('Backend: local\nModels directory: /x\n')).toBeNull();
});

test('lsof output yields each render with the absolute file its output goes to; pipes and terminals are not files', () => {
  expect([...parseDrawThingsLsof('p51886\nf1\nn/tmp/a b.log\np7\nf1\nn->0xab05\np8\nf1\nn/dev/ttys003\np9\nf1\nnrelative.log\n')])
    .toEqual([[51886, '/tmp/a b.log'], [8, '/dev/ttys003']]);
  expect(parseDrawThingsLsof(null).size).toBe(0);
  expect(parseDrawThingsLsof('p1\nf1\nn/tmp/x\n').size).toBe(0);   // pid 1 is never a render
});

test('a watched render shows its live step counter dated by its log, then ends completed or unfinished, keeping nothing private', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-draw-things-')), log = join(dir, 'render.log'), stopped = join(dir, 'stopped.log');
  try {
    const full = await fixture('video-completed.log'), partial = full.slice(0, full.indexOf('Sampling... 9 / 25'));
    await writeFile(log, partial); await utimes(log, 1_000, 1_000);
    await writeFile(stopped, await fixture('image-stopped.log'));
    let now = 1_100_000, listed = `p4242\nf1\nn${log}\np4343\nf1\nn${stopped}\n`;
    const calls: Argv[] = [], source = config();
    const exec = async (argv: Argv) => { calls.push(argv); return listed; };
    const first = await drawThings(source, { now: () => now, exec });
    expect(calls).toEqual([lsofDrawThingsArgv(), ]);
    const running = first.jobs.find(job => job.progress?.total === 25)!;
    expect(running).toMatchObject({ state: 'running', phase: 'sampling', kind: 'unknown', freshness: 'live', progress: { value: 8, total: 25, unit: 'steps', basis: 'phase' },
      progressAtMs: 1_000_000, cancel: { supported: false } });
    expect(running.name).toMatch(/^Render [a-f0-9]{6}$/);
    expect(first.source).toEqual({ id: source.id, kind: 'draw-things', label: 'Draw Things', state: 'ready', capabilities: { progress: true, cancel: false } });
    expect(first.ttlMs).toBe(DRAW_THINGS_READ_MS.active);
    for (const job of first.jobs) expect(parseMediaJob(job)).toEqual(job);
    // The same process and file keep their job id; the counter advances with the log.
    await writeFile(log, full); await utimes(log, 1_110, 1_110); now += 15_000;
    const again = await drawThings(source, { now: () => now, exec });
    expect(again.jobs.find(job => job.id === running.id)).toMatchObject({ phase: 'finishing', progress: null });
    // Both processes exit. One read without them is not yet proof (lsof also fails empty), the second is.
    listed = ''; now += 15_000;
    expect((await drawThings(source, { now: () => now, exec })).jobs.filter(job => job.state === 'running')).toHaveLength(2);
    now += 15_000;
    const ended = await drawThings(source, { now: () => now, exec });
    expect(ended.jobs.find(job => job.id === running.id)).toMatchObject({ state: 'completed', phase: 'completed', kind: 'video', freshness: 'last', finishedAtMs: 1_110_000, progress: null });
    expect(ended.jobs.find(job => job.id !== running.id)).toMatchObject({ state: 'failed', message: 'Ended before finishing; Draw Things printed no error.' });
    expect(ended.ttlMs).toBe(DRAW_THINGS_READ_MS.idle);
    for (const job of ended.jobs) expect(parseMediaJob(job)).toEqual(job);
    expect(kept([first, again, ended])).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Draw Things is found by its installed command-line tool only, only with the host probe, and media.json can turn it off', async () => {
  const home = await mkdtemp(join(tmpdir(), 'scope-draw-things-home-'));
  try {
    const tool = join(home, 'Applications/draw-things-cli-26.1011.0/draw-things-cli');
    await mkdir(join(home, 'Applications/draw-things-cli-26.1011.0'), { recursive: true }); await writeFile(tool, '#!/bin/sh\n');
    expect(await drawThingsInstalled(home, [])).toBe(true);
    expect(await drawThingsInstalled(join(home, 'Applications'), [join(home, 'Applications/draw-things-cli-26.1011.0')])).toBe(true);   // a package folder
    expect(await drawThingsInstalled(join(home, 'nobody'), [])).toBe(false);
    const fetchImpl = async () => { throw new Error('offline'); };
    const found = (drawThingsOption: boolean) => new MediaDiscovery({ home, fetchImpl, drawThings: drawThingsOption }).configurations();
    expect((await found(true)).filter(source => source.kind === 'draw-things')).toEqual([{ id: 'draw-things', kind: 'draw-things', label: 'Draw Things' }]);
    expect((await found(false)).some(source => source.kind === 'draw-things')).toBe(false);
    await mkdir(join(home, '.config/mlx-scope'), { recursive: true });
    await writeFile(mediaConfigPath(home), JSON.stringify({ schemaVersion: 1, sources: [{ id: 'draw-things', kind: 'draw-things', enabled: false }] }));
    expect((await found(true)).some(source => source.kind === 'draw-things')).toBe(false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('without the host probe the source reports itself unavailable rather than inventing renders', async () => {
  await expect(drawThings(config(), { now: () => 1 })).rejects.toThrow();
});
