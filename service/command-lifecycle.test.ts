import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readCommand } from './native-command.ts';

type SpawnCommand = NonNullable<Parameters<typeof readCommand>[4]>;
function fixture(events: (child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }) => void): SpawnCommand {
  return (_file, _args, options) => {
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(options.shell).toBe(false);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: null,
      exitCode: 0, signalCode: null,
    });
    queueMicrotask(() => events(child));
    return child as unknown as ReturnType<SpawnCommand>;
  };
}

test('waits for all output after exit without depending on the combined close event', async () => {
  const spawn = fixture(child => {
    child.stdout.write('first');
    child.emit('exit', 0, null);
    setTimeout(() => { child.stdout.end(' last'); child.stderr.end(); }, 10);
  });
  expect(await readCommand('/fixture', [], 250, 1024, spawn)).toBe('first last');
});

test('waits for a successful exit when output ends first', async () => {
  let exited = false;
  const spawn = fixture(child => {
    child.stdout.end('complete'); child.stderr.end();
    setTimeout(() => { exited = true; child.emit('exit', 0, null); }, 10);
  });
  expect(await readCommand('/fixture', [], 250, 1024, spawn)).toBe('complete');
  expect(exited).toBe(true);
});

test('never treats partial output from a failed exit as a sample', async () => {
  const spawn = fixture(child => {
    child.stdout.end('partial'); child.stderr.end(); child.emit('exit', 1, null);
  });
  expect(await readCommand('/fixture', [], 250, 1024, spawn)).toBeNull();
});

test('closed output without EOF stays unavailable even after a successful exit', async () => {
  const spawn = fixture(child => {
    child.stdout.write('partial'); child.stdout.destroy();
    child.stderr.end(); child.emit('exit', 0, null);
  });
  expect(await readCommand('/fixture', [], 250, 1024, spawn)).toBeNull();
});

test.skipIf(process.platform === 'win32')('immediate native exits preserve complete output across repeated reads', async () => {
  for (let i = 0; i < 30; i++) expect(await readCommand('/bin/echo', ['sample'])).toBe('sample\n');
});
