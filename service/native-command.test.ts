import { expect, test } from 'bun:test';
import { readCommand } from './native-command.ts';
const run = (source: string, timeout = 1000, bytes = 65536) => readCommand(process.execPath, ['-e', source], timeout, bytes);

test('native reader collects fast output and requires successful exit', async () => {
  expect(await run('process.stdout.write("hello")')).toBe('hello');
  expect(await run('process.stdout.write("partial"); process.exit(1)')).toBeNull();
  expect(await readCommand('/does/not/exist', [])).toBeNull();
});
test('native reader terminates hung children at its own deadline', async () => {
  const start = performance.now();
  expect(await run('setInterval(()=>{},1000)',100)).toBeNull();
  expect(performance.now()-start).toBeLessThan(1500);
});
test('native reader bounds stdout and stderr rather than buffering indefinitely', async () => {
  expect(await run('process.stdout.write("x".repeat(10000))',1000,500)).toBeNull();
  expect(await run('process.stderr.write("x".repeat(10000))',1000,500)).toBeNull();
});
test('native reader survives repeated immediate exits without pending work', async () => {
  for (let i=0;i<12;i++) expect(await run('process.stdout.write("ok")')).toBe('ok');
});
