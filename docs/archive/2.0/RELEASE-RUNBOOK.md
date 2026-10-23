# Manual release runbook

This procedure mirrors `.github/workflows/release.yml` step for step. **Use it only with an explicit owner waiver
while hosted CI is unavailable** (for example the Actions billing lock). When hosted CI runs, push the tag and let the
Release workflow publish instead.

**What the waiver covers**
- Only the Linux legs of CI: the `ubuntu-latest` verify job and the Linux Chromium/WebKit job.
- The macOS leg still runs, locally, through `scripts/ci-local.sh`. Its receipt is labelled as a local record, not
  hosted CI.
- A failing check is never waived. Fix it and start again.
- The waiver is per version. The owner states it in writing, naming the version, and it is recorded in the receipt
  commit (step 3).

| release.yml | Manual equivalent |
|---|---|
| `verify` (ci.yml on Linux and macOS, browsers on Linux) | `scripts/ci-local.sh` on macOS, plus the waiver |
| Download the `mlx-scope-package` artifact (built on Linux) | `bun run verify:package` at the tag (built on macOS); its digest must equal the receipt's |
| Verify release identity and notes | The same script (step 5) |
| Verify checksum | The same `sha256sum --check` (step 5) |
| Decide the Latest label | The same commands (step 6) |
| Publish verified package | The same `gh release create … --verify-tag` (step 7) |

If `release.yml` changes, update this runbook in the same commit.

## 1. Prepare the release commit
- Follow CONTRIBUTING.md → Releasing, steps 1–4: the version, the README asset name, a `## <version>` changelog
  section, and rebuilt, committed bundles.
- Use Bun from `.bun-version` (1.4.2) and Node 22. Another Bun version can change the committed bundles.
- Leave the checkout clean.

## 2. Run the macOS leg
```sh
scripts/ci-local.sh
```
It must end with `PASS` and write `docs/receipts/ci-<sha7>.json` with:
- `"result": "pass"` and `sha` equal to the release commit;
- `unit.fail` 0, `browser.fail` 0, and `browser.projects` = chromium, webkit;
- `zip.name` = `mlx-scope-openchamber-<version>.zip`.

The Linux legs did not run. That is exactly what the waiver covers.

## 3. Commit the receipt and the waiver
```sh
tested=$(git rev-parse HEAD)
git add "docs/receipts/ci-$(git rev-parse --short=7 HEAD).json"
git commit -m "Receipt for v<version>: local macOS leg" \
  -m "Owner waiver <date>: hosted CI unavailable, the Linux legs did not run."
git diff --name-only "$tested" HEAD
```
The last command must list only the receipt. Receipts are not in the package, so this commit builds the same ZIP as
the tested one.

## 4. Tag and push
Run steps 4–7 in one shell session; later steps reuse its variables.
```sh
version=$(node -p 'require("./package.json").version')
git push origin HEAD
git tag "v$version"
git push origin "v$version"
```
- `git push origin HEAD` publishes the release branch: `main`, or `legacy/1.6.x` for a legacy release. Pushing to
  `main` is the public launch; do it only at the matching owner gate.
- Pushing the tag also queues the hosted Release workflow. If it actually runs, stop here and let it publish. If it
  runs after a manual publish, its `gh release create` fails because the release already exists, so nothing is
  published twice.

## 5. Build and verify the package at the tag
Run from the repository root, on the tagged commit with a clean checkout. The temporary directory stands in for the
runner.
```sh
export RELEASE_TAG="v$version" GH_REPO=mikebuckets171/mlx-scope-openchamber
export GITHUB_REPOSITORY="$GH_REPO" RUNNER_TEMP="$(mktemp -d)"
export GITHUB_ENV="$RUNNER_TEMP/env"
test "$(git rev-parse HEAD)" = "$(git rev-parse "$RELEASE_TAG^{commit}")" && test -z "$(git status --porcelain)" ||
  echo "STOP: this is not a clean checkout of $RELEASE_TAG"
bun install --frozen-lockfile
bun run verify:package
```
The printed `SHA-256` must equal `zip.sha256` in the receipt.

**Verify release identity and notes** (copied verbatim from `release.yml`):
```sh
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(pkg.name, 'mlx-scope-openchamber');
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
assert.equal(process.env.RELEASE_TAG, `v${pkg.version}`);
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const heading = `## ${pkg.version}\n`;
const position = changelog.indexOf(heading);
assert(position >= 0, 'Release needs a matching changelog entry.');
const notes = changelog.slice(position + heading.length).split('\n## ')[0].trim();
assert(notes.length > 0, 'Release notes must not be empty.');
const asset = `${pkg.name}-${pkg.version}.zip`;
const install = `Install **${asset}** in OpenChamber. GitHub source archives are not install packages. A SHA-256 file accompanies the ZIP.`;
writeFileSync(join(process.env.RUNNER_TEMP, 'release-notes.md'), `${notes}\n\n${install}\n`);
writeFileSync(process.env.GITHUB_ENV, `RELEASE_ASSET=${asset}\n`, { flag: 'a' });
JS
. "$GITHUB_ENV"
cat "$RUNNER_TEMP/release-notes.md"
```
The notes are the changelog section followed by the install sentence. Nothing else is added.

**Verify checksum.** On a macOS without `sha256sum`, use `shasum -a 256 --check` instead.
```sh
(cd dist && sha256sum --check "$RELEASE_ASSET.sha256")
```

## 6. Decide the Latest label
Only the highest published version is Latest.
```sh
gh api --paginate "repos/$GITHUB_REPOSITORY/releases?per_page=100" \
  --jq '.[] | select((.draft or .prerelease) | not) | .tag_name' > "$RUNNER_TEMP/released-tags"
newest=$({ cat "$RUNNER_TEMP/released-tags"; echo "$RELEASE_TAG"; } | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)
if [ "$newest" = "$RELEASE_TAG" ]; then latest=true; else latest=false; fi
echo "RELEASE_LATEST=$latest" >> "$GITHUB_ENV"
. "$GITHUB_ENV"; echo "$RELEASE_LATEST"
```
- **Legacy releases use `--latest=false`.** Once 2.0.0 is published, every `legacy/1.6.x` version is lower, so this
  prints `false`. If it prints `true` for a legacy release after 2.0, stop.
- A 2.x release prints `true`.

## 7. Publish
```sh
gh release create "$RELEASE_TAG" \
  "dist/$RELEASE_ASSET" "dist/$RELEASE_ASSET.sha256" \
  --verify-tag --title "MLX Scope $RELEASE_TAG" \
  --notes-file "$RUNNER_TEMP/release-notes.md" \
  --latest="$RELEASE_LATEST"
```
`--verify-tag` refuses to publish unless the tag from step 4 exists on GitHub.

**Check the result**
```sh
gh release view "$RELEASE_TAG" --json assets --jq '.assets[] | "\(.name) \(.digest)"'
gh release list --limit 3 --json tagName,isLatest
```
- The ZIP's digest must be `sha256:` followed by the receipt's `zip.sha256`.
- Latest must sit on the highest version.

## Legacy line
- `legacy/1.6.x` serves OpenChamber 1.24.x–2.0.3 and takes security and correctness fixes only.
- The branch was cut at v1.6.1, before `.bun-version`, `scripts/ci-local.sh`, the `legacy/**` CI trigger and the
  Latest step existed. Before its first release, cherry-pick the commit that added this runbook onto it. That commit
  changes no product code, but it needs an owner yes like any legacy change.
- Everything else is the same: the tag equals `v<version>`, the notes come from the changelog, the ZIP and its
  `.sha256` come from `verify:package`, and step 6 must print `false`.

## Rollback
- **Fix forward.** Never delete, move or re-push a published tag. Release the fix as the next patch version; semver
  must increase.
- **Severe case.** Users pin `…/mlx-scope-openchamber#legacy/1.6.x` until the fix ships. v1 captures survive, because
  2.0.x keeps the v1 storage keys.
- **Wrong Latest label.** Run `gh release edit <highest tag> --latest`. It moves the label without touching assets.
- The full rollback procedure is `docs/2.0/ROLLBACK.md` (Stage 11).
