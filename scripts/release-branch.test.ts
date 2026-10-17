import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isNewer, releaseVersion, updateReleaseBranch } from './release-branch.ts';

const temps: string[] = [];
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });
const temp = (): string => { const path = mkdtempSync(join(tmpdir(), 'scope-release-test-')); temps.push(path); return path; };
const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
const pkg = (version: string) => JSON.stringify({ name: 'mlx-scope-openchamber', version });
/** A source repo whose HEAD is `version`, and a verified-looking ZIP of `files` (+ package.json) beside it. */
const fixture = (version: string, files: Record<string, string>, repo = temp()) => {
  if (spawnSync('git', ['rev-parse', '--git-dir'], { cwd: repo }).status !== 0) git(repo, 'init', '-q');
  writeFileSync(join(repo, 'package.json'), pkg(version)); writeFileSync(join(repo, 'README.md'), 'source only\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', `source ${version}`);
  const stage = temp(), all = { 'package.json': pkg(version), ...files };
  for (const [name, text] of Object.entries(all)) { mkdirSync(dirname(join(stage, name)), { recursive: true }); writeFileSync(join(stage, name), text); }
  const zip = join(temp(), `mlx-scope-openchamber-${version}.zip`);
  expect(spawnSync('zip', ['-X', '-q', zip, ...Object.keys(all).sort()], { cwd: stage }).status).toBe(0);
  const digest = createHash('sha256').update(readFileSync(zip)).digest('hex');
  writeFileSync(`${zip}.sha256`, `${digest}  mlx-scope-openchamber-${version}.zip\n`);
  return { repo, zip, digest };
};
// The test repo has no identity of its own; the script uses the caller's Git configuration.
const env = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
Object.assign(process.env, env);
const tree = (repo: string, ref: string): string[] => git(repo, 'ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean).sort();

test('only plain release versions compare, and only a strictly newer one wins', () => {
  expect(releaseVersion('5.1.0')).toEqual([5, 1, 0]);
  for (const bad of ['5.1', '5.1.0-dev.1', 'v5.1.0', '05.1.0', 5]) expect(releaseVersion(bad)).toBeNull();
  expect([isNewer('5.1.0', '5.0.0'), isNewer('5.10.0', '5.9.9'), isNewer('5.1.0', '5.1.0'), isNewer('5.0.9', '5.1.0'), isNewer('5.1.0-rc.1', '5.0.0')])
    .toEqual([true, true, false, false, false]);
});

test('a first release creates the branch with exactly the ZIP’s files and records the source and digest', () => {
  const { repo, zip, digest } = fixture('5.1.0', { 'service/main.js': 'export {};\n', 'panel/index.html': '<!doctype html>\n' });
  const result = updateReleaseBranch({ repo, zip, smoke: false });
  expect(result).toMatchObject({ version: '5.1.0', previous: null, files: 3, pushed: false, packageSha256: digest });
  expect(tree(repo, 'release')).toEqual(['package.json', 'panel/index.html', 'service/main.js']);
  expect(git(repo, 'rev-list', '--count', 'release')).toBe('1');
  const message = git(repo, 'log', '-1', '--format=%B', 'release');
  expect(message).toContain('MLX Scope 5.1.0');
  expect(message).toContain(`Source-Commit: ${git(repo, 'rev-parse', 'main')}`);
  expect(message).toContain(`Package-SHA256: ${digest}`);
  expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  expect(git(repo, 'branch', '--show-current')).toBe('main');
});

test('a newer release moves the branch forward, drops files the ZIP no longer has, and pushes only when asked', () => {
  const remote = temp(); git(remote, 'init', '-q', '--bare');
  const first = fixture('5.1.0', { 'background/main.js': 'old\n', 'service/main.js': 'one\n' });
  git(first.repo, 'remote', 'add', 'origin', remote);
  updateReleaseBranch({ repo: first.repo, zip: first.zip, remote: 'origin', push: true, smoke: false });
  expect(tree(remote, 'release')).toEqual(['background/main.js', 'package.json', 'service/main.js']);
  // A different clone without the local branch fetches the published one and builds on it.
  const second = fixture('5.1.1', { 'service/main.js': 'two\n' }, first.repo);
  git(first.repo, 'branch', '-D', 'release');
  const result = updateReleaseBranch({ repo: second.repo, zip: second.zip, remote: 'origin', push: true, smoke: false });
  expect(result).toMatchObject({ version: '5.1.1', previous: '5.1.0', pushed: true });
  expect(tree(remote, 'release')).toEqual(['package.json', 'service/main.js']);
  expect(git(remote, 'show', 'release:service/main.js')).toBe('two');
  expect(git(remote, 'rev-list', '--count', 'release')).toBe('2');
  const third = fixture('5.1.2', { 'service/main.js': 'three\n' }, first.repo);
  updateReleaseBranch({ repo: third.repo, zip: third.zip, remote: 'origin', smoke: false });
  expect(git(remote, 'show', 'release:service/main.js')).toBe('two');
});

test('the same or an older version, a wrong checksum, a mismatched source commit or an unsafe entry is refused', () => {
  const { repo, zip } = fixture('5.1.0', { 'service/main.js': 'one\n' });
  updateReleaseBranch({ repo, zip, smoke: false });
  const before = git(repo, 'rev-parse', 'release');
  expect(() => updateReleaseBranch({ repo, zip, smoke: false })).toThrow("5.1.0 is not newer than the release branch's 5.1.0");
  const older = fixture('5.0.9', { 'service/main.js': 'old\n' }, repo);
  expect(() => updateReleaseBranch({ repo, zip: older.zip, smoke: false })).toThrow('is not newer');
  expect(git(repo, 'rev-parse', 'release')).toBe(before);

  const next = fixture('5.1.1', { 'service/main.js': 'two\n' }, repo);
  writeFileSync(`${next.zip}.sha256`, `${'0'.repeat(64)}  mlx-scope-openchamber-5.1.1.zip\n`);
  expect(() => updateReleaseBranch({ repo, zip: next.zip, smoke: false })).toThrow('does not match its SHA-256 file');
  rmSync(`${next.zip}.sha256`);
  expect(() => updateReleaseBranch({ repo, zip: next.zip, smoke: false })).toThrow('Missing');

  const later = fixture('5.1.2', { 'service/main.js': 'three\n' }, repo);
  expect(() => updateReleaseBranch({ repo, zip: later.zip, sourceCommit: 'HEAD~1', smoke: false })).toThrow('is not version 5.1.2');

  const unsafe = temp(); mkdirSync(join(unsafe, '.github'));
  writeFileSync(join(unsafe, 'package.json'), pkg('5.1.3')); writeFileSync(join(unsafe, '.github', 'x'), 'x');
  const unsafeZip = join(temp(), 'mlx-scope-openchamber-5.1.3.zip');
  spawnSync('zip', ['-X', '-q', unsafeZip, 'package.json', '.github/x'], { cwd: unsafe });
  writeFileSync(`${unsafeZip}.sha256`, `${createHash('sha256').update(readFileSync(unsafeZip)).digest('hex')}  mlx-scope-openchamber-5.1.3.zip\n`);
  writeFileSync(join(repo, 'package.json'), pkg('5.1.3')); git(repo, 'commit', '-q', '-am', '5.1.3');
  expect(() => updateReleaseBranch({ repo, zip: unsafeZip, smoke: false })).toThrow('Unsafe or empty ZIP entry list');
  expect(git(repo, 'rev-parse', 'release')).toBe(before);
});
