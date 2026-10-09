import { expect, test } from 'bun:test';
import { allowed, createExec, localVideoCancelArgv } from './argv.ts';
test('video control only admits a single exact job cancellation; no list, wake, shell or path arguments', async () => {
  const home = '/home/fixture', id = '20261009T002930-681f21ae';
  const argv = localVideoCancelArgv(id, home)!; expect(allowed(argv, home)).toBe(true);
  for (const value of ['--all', '../job', id + ';exit', '', 'running']) expect(localVideoCancelArgv(value, home)).toBeNull();
  expect(allowed({ ...argv, args: ['list'] }, home)).toBe(false);
  expect(allowed({ ...argv, args: ['cancel', id, '--all'] }, home)).toBe(false);
  let called = 0;
  const exec = createExec(home, async (_file, args) => { called++; expect(args).toEqual(['cancel', id]); return '{}'; });
  await exec(argv); expect(called).toBe(1);
});
