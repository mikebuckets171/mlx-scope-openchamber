import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appName, groupApps, parseTop } from './apps.ts';

const TOP = readFileSync(join(import.meta.dir, '../../tests/fixtures/host/macos-27/top.mem.txt'), 'utf8');
const MiB = 2 ** 20, GiB = 2 ** 30;

test('top rows: PID, the 16-character name and the physical footprint in bytes, under the PID COMMAND MEM header only', () => {
  const rows = parseTop(TOP);
  expect(rows[0]).toEqual({ pid: 4243, name: 'splash', bytes: 31 * GiB });
  expect(rows.find(row => row.name === 'com.apple.WebKit')).toEqual({ pid: 777, name: 'com.apple.WebKit', bytes: 388 * MiB });
  expect(rows.find(row => row.name === 'tiny')!.bytes).toBe(12 * 1024);
  // PID 0 (the kernel) is not a process Scope reports; the header block above the table is never a row.
  expect(rows.map(row => row.pid)).not.toContain(0);
  expect(rows).toHaveLength(11);
  expect(parseTop('PhysMem: 47G used\n 12 node 3G')).toEqual([]);
  expect(parseTop(null)).toEqual([]);
  expect(parseTop('PID    COMMAND          MEM  \n1 a b c\n2 ok 1.5G+\n')).toEqual([{ pid: 2, name: 'ok', bytes: 1.5 * GiB }]);
});

test('helpers count toward their app; the engine and the kernel are left out', () => {
  expect(['OpenChamber Help', 'Google Chrome He', 'Discord Helper (', 'Exampleapps Help', 'Viewer Helper (G', 'node', 'com.apple.WebKit', 'Sample Editor', 'Short Help']
    .map(appName)).toEqual(['OpenChamber', 'Google Chrome', 'Discord', 'Exampleapps', 'Viewer', 'node', 'com.apple.WebKit', 'Sample Editor', 'Short Help']);
  const apps = groupApps(parseTop(TOP), 4);
  expect(apps).toEqual([{ name: 'Exampleapps', bytes: (1379 + 927) * MiB }, { name: 'opencode', bytes: 1348 * MiB },
    { name: 'node', bytes: 1107 * MiB }, { name: 'WindowServer', bytes: 1059 * MiB }]);
  expect(groupApps(parseTop(TOP), Infinity).map(app => app.name)).not.toContain('splash');
  expect(groupApps(parseTop(TOP), Infinity).find(app => app.name === 'Viewer')!.bytes).toBe((643 + 402) * MiB);
});
