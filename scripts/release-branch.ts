import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

// The `release` branch is what a Git install of MLX Scope follows (`<repo>#release`). It holds exactly the files of one
// verified install ZIP, so a Git install and a ZIP install run the same bytes. This script moves the branch to a new
// ZIP: it checks the ZIP's SHA-256 file, refuses a version that is not newer, makes the branch tree equal the ZIP entries
// byte for byte, and commits with the source commit and package digest as trailers. It pushes only with `--push`, then
// re-checks a fresh shallow clone of what was published. It never creates tags; release tags stay on source commits.

export interface ReleaseBranchOptions {
  /** The source repository (its checkout root). */
  repo: string;
  /** The verified install ZIP; its `<zip>.sha256` file must match. */
  zip: string;
  branch?: string;
  /** Remote to fetch an existing branch from and, with `push`, to push to. */
  remote?: string | null;
  push?: boolean;
  /** Defaults to the source checkout's HEAD; its package.json must name the ZIP's version. */
  sourceCommit?: string;
  /** Run scripts/smoke-service.mjs against the fresh clone (default true). */
  smoke?: boolean;
  log?: (line: string) => void;
}
export interface ReleaseBranchResult { version: string; previous: string | null; commit: string; packageSha256: string; files: number; pushed: boolean }

const PACKAGE_NAME = 'mlx-scope-openchamber';
const run = (file: string, args: string[], cwd: string, timeout = 60_000): string => {
  const result = spawnSync(file, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 16_000_000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } });
  if (result.error || result.status !== 0) throw new Error(`${file} ${args[0] ?? ''} failed: ${(result.error?.message ?? result.stderr ?? '').trim()}`);
  return result.stdout;
};
// Bytes go in and out of Git unchanged, whatever the caller's configuration says about line endings.
const git = (cwd: string, ...args: string[]): string => run('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'commit.gpgsign=false', ...args], cwd);
const lines = (text: string): string[] => text.split('\n').filter(Boolean);

/** A release version, `major.minor.patch` only; pre-releases never reach the release branch. */
export const releaseVersion = (value: unknown): [number, number, number] | null => {
  const match = typeof value === 'string' ? /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};
export const isNewer = (next: string, previous: string): boolean => {
  const a = releaseVersion(next), b = releaseVersion(previous);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! > b[index]!;
  return false;
};
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const versionOf = (text: string): string => { const pkg = JSON.parse(text); if (pkg?.name !== PACKAGE_NAME) throw new Error(`package.json does not name ${PACKAGE_NAME}.`); return pkg.version; };

/** The tree at `root` (tracked files) must be the entry list, each file identical to the extracted ZIP copy. */
const assertTreeMatches = (root: string, entries: readonly string[], extracted: string, where: string): void => {
  const tracked = lines(git(root, 'ls-files', '-z').replaceAll('\0', '\n')).sort();
  if (JSON.stringify(tracked) !== JSON.stringify(entries)) {
    const extra = tracked.filter(name => !entries.includes(name)), missing = entries.filter(name => !tracked.includes(name));
    throw new Error(`${where} differs from the ZIP (extra: ${extra.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}).`);
  }
  for (const name of entries) {
    if (!readFileSync(join(root, name)).equals(readFileSync(join(extracted, name)))) throw new Error(`${where}: ${name} differs from the ZIP.`);
  }
};

export const updateReleaseBranch = (options: ReleaseBranchOptions): ReleaseBranchResult => {
  const repo = resolve(options.repo), zip = resolve(options.zip), branch = options.branch ?? 'release', remote = options.remote ?? null;
  const log = options.log ?? (() => {});
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch) || branch.includes('..')) throw new Error('Invalid branch name.');
  const bytes = readFileSync(zip), digest = sha256(bytes), shaFile = `${zip}.sha256`;
  if (!existsSync(shaFile)) throw new Error(`Missing ${basename(shaFile)}.`);
  if (readFileSync(shaFile, 'utf8').trim() !== `${digest}  ${basename(zip)}`) throw new Error('The ZIP does not match its SHA-256 file.');

  const work = mkdtempSync(join(tmpdir(), 'mlx-scope-release-')), extracted = join(work, 'extracted'), tree = join(work, 'tree');
  let worktreeAdded = false;
  try {
    const entries = lines(run('unzip', ['-Z1', zip], work)).filter(name => !name.endsWith('/')).sort();
    if (!entries.length || entries.some(name => isAbsolute(name) || name.split('/').includes('..') || name.startsWith('.git'))) throw new Error('Unsafe or empty ZIP entry list.');
    if (new Set(entries).size !== entries.length) throw new Error('Duplicate ZIP entries.');
    run('unzip', ['-q', zip, '-d', extracted], work);
    const version = versionOf(readFileSync(join(extracted, 'package.json'), 'utf8'));
    if (!releaseVersion(version)) throw new Error(`${version} is not a release version.`);
    if (basename(zip) !== `${PACKAGE_NAME}-${version}.zip`) throw new Error(`The ZIP name does not match version ${version}.`);
    const sourceCommit = git(repo, 'rev-parse', '--verify', `${options.sourceCommit ?? 'HEAD'}^{commit}`).trim();
    if (versionOf(git(repo, 'show', `${sourceCommit}:package.json`)) !== version) throw new Error(`Source commit ${sourceCommit.slice(0, 12)} is not version ${version}.`);

    // An existing branch: the local one, else the remote's (fetched into a new local branch, never over one).
    const local = (): boolean => spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo }).status === 0;
    if (!local() && remote && lines(git(repo, 'ls-remote', '--heads', remote, `refs/heads/${branch}`)).length) {
      git(repo, 'fetch', '--quiet', remote, `refs/heads/${branch}:refs/heads/${branch}`);
    }
    let previous: string | null = null;
    if (local()) {
      git(repo, 'worktree', 'add', '--quiet', tree, branch); worktreeAdded = true;
      previous = existsSync(join(tree, 'package.json')) ? versionOf(readFileSync(join(tree, 'package.json'), 'utf8')) : null;
      if (previous !== null && !isNewer(version, previous)) throw new Error(`${version} is not newer than the ${branch} branch's ${previous}.`);
      if (lines(git(tree, 'ls-files')).length) git(tree, 'rm', '-r', '-q', '--', '.');
    } else {
      git(repo, 'worktree', 'add', '--quiet', '--detach', tree); worktreeAdded = true;
      git(tree, 'checkout', '--quiet', '--orphan', branch);
      git(tree, 'rm', '-r', '-q', '--cached', '--', '.');
    }
    git(tree, 'clean', '-q', '-fdx');
    for (const name of entries) { mkdirSync(dirname(join(tree, name)), { recursive: true }); copyFileSync(join(extracted, name), join(tree, name)); }
    git(tree, 'add', '-A', '--', '.');
    assertTreeMatches(tree, entries, extracted, `The ${branch} tree`);
    git(tree, 'commit', '--quiet', '-m', `MLX Scope ${version}`, '-m', `Source-Commit: ${sourceCommit}\nPackage-SHA256: ${digest}`);
    const commit = git(tree, 'rev-parse', 'HEAD').trim();
    log(`${branch}: ${previous ?? 'new branch'} → ${version} (${commit.slice(0, 12)}), ${entries.length} files`);

    if (options.push) {
      if (!remote) throw new Error('--push needs a remote.');
      // A fast-forward only: the new commit's parent is the published tip, so nothing published is ever rewritten.
      git(repo, 'push', '--quiet', remote, `refs/heads/${branch}:refs/heads/${branch}`);
      log(`pushed ${branch} to ${remote}`);
    }
    // Re-check what a Git install would fetch: a fresh shallow clone of the published (or local) branch.
    const source = options.push ? git(repo, 'remote', 'get-url', remote!).trim() : `file://${repo}`;
    const clone = join(work, 'clone');
    git(work, 'clone', '--quiet', '--depth', '1', '--branch', branch, source, clone);
    if (git(clone, 'rev-parse', 'HEAD').trim() !== commit) throw new Error('The fresh clone is not at the new release commit.');
    assertTreeMatches(clone, entries, extracted, 'The fresh clone');
    const tags = lines(git(repo, 'tag', '--points-at', commit)).filter(tag => /^v\d/.test(tag));
    if (tags.length) throw new Error(`Release tags must stay on source commits, not ${branch}: ${tags.join(', ')}.`);
    if (options.smoke !== false) {
      const smoke = run('node', [join(repo, 'scripts/smoke-service.mjs'), clone], clone, 60_000);
      if (!smoke.includes('/v2/snapshot, the retired /snapshot 410')) throw new Error('The service smoke did not pass on the fresh clone.');
      log('fresh clone: tree matches the ZIP; service smoke passed');
    }
    return { version, previous, commit, packageSha256: digest, files: entries.length, pushed: !!options.push };
  } finally {
    if (worktreeAdded) spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: repo });
    rmSync(work, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const args = process.argv.slice(2), flag = (name: string): string | undefined => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const repo = resolve(import.meta.dir, '..'), pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const result = updateReleaseBranch({ repo, zip: flag('--zip') ?? join(repo, 'dist', `${pkg.name}-${pkg.version}.zip`), branch: flag('--branch'),
    remote: flag('--remote') ?? (args.includes('--push') ? 'origin' : null), push: args.includes('--push'), sourceCommit: flag('--source-commit'),
    log: line => console.log(line) });
  console.log(`PASS: ${result.files} files, ${result.version} at ${result.commit}, package ${result.packageSha256}${result.pushed ? ', pushed' : ', not pushed'}.`);
}
