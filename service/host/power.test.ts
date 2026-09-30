import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { allowed, MACMON_LINE_BYTES, type Argv, type StreamChild } from '../lib/argv.ts';
import { createPowerStream, findMacmon, POWER_STALE_MS } from './power.ts';

const FIXTURES = join(import.meta.dir, '../../tests/fixtures/host/macos-27');
const NORMAL = readFileSync(join(FIXTURES, 'macmon-pipe.normal.txt'), 'utf8').split('\n').filter(Boolean);
const MACMON = '/opt/homebrew/bin/macmon';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const line = (chipW: number) => `{"all_power":${chipW},"ane_power":0.0,"cpu_power":1.0,"gpu_power":${chipW - 1},"sys_power":0.0}\n`;

type FakeChild = StreamChild & { stdout: PassThrough; signals: string[]; exit(code?: number): void };
const harness = () => {
  const spawned: Argv[] = [], children: FakeChild[] = [];
  const clock = { now: 1_790_690_700_000 };
  const spawn = (argv: Argv): StreamChild | null => {
    if (!allowed(argv, '/Users/someone')) return null;
    spawned.push(argv);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: null, stdin: null, exitCode: null as number | null,
      signalCode: null as string | null, signals: [] as string[] }) as unknown as FakeChild;
    child.kill = ((signal: string) => { child.signals.push(signal); child.exit(); return true; }) as FakeChild['kill'];
    child.exit = (code = 0) => { (child as { exitCode: number | null }).exitCode = code; child.emit('exit', code, null); };
    children.push(child);
    return child;
  };
  return { spawned, children, clock, spawn };
};
const feed = async (child: FakeChild, text: string) => { child.stdout.write(text); await wait(1); };

test('findMacmon only stats the two allowlisted paths', () => {
  const asked: string[] = [];
  expect(findMacmon(file => { asked.push(file); throw new Error('ENOENT'); })).toBeNull();
  expect(asked).toEqual(['/opt/homebrew/bin/macmon', '/usr/local/bin/macmon']);
  expect(findMacmon(file => { if (file.startsWith('/opt')) throw new Error('ENOENT'); })).toBe('/usr/local/bin/macmon');
});

test('without macmon there is no stream, no reading and no energy', () => {
  const { spawn, spawned } = harness();
  const stream = createPowerStream({ macmon: null, now: () => 0, spawn });
  stream.touch();
  expect(spawned).toHaveLength(0);
  expect(stream.view(0)).toBeUndefined();
  expect(stream.energy(0, 10_000)).toBeNull();
});

test('a touch starts `macmon pipe -i 1000`; lines split across chunks parse once complete', async () => {
  const { spawn, spawned, children, clock } = harness();
  const stream = createPowerStream({ macmon: MACMON, now: () => clock.now, spawn, idleStopMs: 5_000 });
  stream.touch(); stream.touch();
  expect(spawned).toEqual([{ file: MACMON, args: ['pipe', '-i', '1000'], timeoutMs: 60_000, maxBytes: MACMON_LINE_BYTES }]);
  const [child] = children;
  const text = `${NORMAL[0]}\n`;
  await feed(child!, text.slice(0, 100));
  expect(stream.view(clock.now)).toBeUndefined();
  await feed(child!, text.slice(100));
  expect(stream.view(clock.now)).toMatchObject({ field: 'all_power', chipW: 28.282001, sampledAt: clock.now, coverageFraction: 0.1 });
  // An oversize line is dropped whole, and the next line still parses.
  await feed(child!, `{"all_power":1,"pad":"${'x'.repeat(MACMON_LINE_BYTES)}"}\n`);
  clock.now += 1_000;
  await feed(child!, line(12));
  expect(stream.view(clock.now)).toMatchObject({ chipW: 12, cpuW: 1, gpuW: 11, aneW: 0, coverageFraction: 0.2 });
  expect(stream.view(clock.now)).not.toHaveProperty('sysW');
  // A stalled stream is no reading, not the last one.
  expect(stream.view(clock.now + POWER_STALE_MS + 1)).toBeUndefined();
  stream.dispose();
  expect(children[0]!.signals).toEqual(['SIGTERM']);
});

test('energy integrates the covered seconds and needs 80% coverage', async () => {
  const { spawn, children, clock } = harness();
  const start = clock.now;
  const stream = createPowerStream({ macmon: MACMON, now: () => clock.now, spawn, idleStopMs: 5_000 });
  stream.touch();
  for (let second = 1; second <= 10; second++) {
    clock.now = start + second * 1_000;
    await feed(children[0]!, line(second === 5 ? 30 : 10));
  }
  expect(stream.energy(start, start + 10_000)).toEqual({ energyJ: 120, coverage: 1 });
  expect(stream.energy(start + 2_500, start + 4_500)!.energyJ).toBeCloseTo(30);   // 5 + 10 + half of the 30 W second
  // 10 s covered of a 12 s span is 83%: scaled to the span as mean power × duration.
  expect(stream.energy(start - 2_000, start + 10_000)).toEqual({ energyJ: 144, coverage: 10 / 12 });
  expect(stream.energy(start - 5_000, start + 10_000)).toBeNull();
  expect(stream.energy(start + 5_000, start + 5_000)).toBeNull();
  expect(stream.view(clock.now)!.coverageFraction).toBe(1);
  stream.dispose();
});

test('a late line never counts a moment twice', async () => {
  const { spawn, children, clock } = harness();
  const start = clock.now;
  const stream = createPowerStream({ macmon: MACMON, now: () => clock.now, spawn, idleStopMs: 5_000 });
  stream.touch();
  for (const offset of [1_000, 1_300, 2_300]) { clock.now = start + offset; await feed(children[0]!, line(10)); }
  expect(stream.energy(start, start + 2_300)).toEqual({ energyJ: 23, coverage: 1 });
  stream.dispose();
});

test('the idle-stop ends macmon 60 s (here 30 ms) after the last full-tier touch', async () => {
  const { spawn, children } = harness();
  const stream = createPowerStream({ macmon: MACMON, now: () => 0, spawn, idleStopMs: 30 });
  stream.touch();
  await wait(15);
  stream.touch();
  await wait(20);
  expect(children[0]!.signals).toEqual([]);
  await wait(30);
  expect(children[0]!.signals).toEqual(['SIGTERM']);
  stream.touch();
  expect(children).toHaveLength(2);
  stream.dispose();
});

test('an exit while wanted restarts with backoff; five silent exits stop retrying until the next demand window', async () => {
  const { spawn, children } = harness();
  const stream = createPowerStream({ macmon: MACMON, now: () => 0, spawn, idleStopMs: 5_000, restartBaseMs: 1 });
  stream.touch();
  for (let exits = 0; exits < 5; exits++) {
    const child = children.at(-1)!;
    child.exit(1);
    await wait(40);
  }
  expect(children).toHaveLength(5);
  stream.touch();
  expect(children).toHaveLength(5);
  stream.dispose();
});

test('an argv outside the allowlist never spawns', () => {
  const { spawn, spawned } = harness();
  const stream = createPowerStream({ macmon: '/tmp/macmon', now: () => 0, spawn, idleStopMs: 5_000 });
  stream.touch(); stream.touch();
  expect(spawned).toHaveLength(0);
  stream.dispose();
});
