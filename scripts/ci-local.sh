#!/bin/sh
# The macOS leg of .github/workflows/ci.yml, run locally while hosted CI is unavailable: install, check, the
# tracked-bundle diff, then the Chromium and WebKit tests. Writes docs/receipts/ci-<sha>.json for the tested
# commit. The receipt is a local record, NOT hosted CI: the Linux leg does not run here.
set -eu
cd "$(dirname "$0")/.."

die() { printf 'ci-local: %s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || die 'this is the macOS leg of CI; run it on macOS.'
bun=$(tr -d '[:space:]' < .bun-version)
[ "$(bun --version)" = "$bun" ] || die "Bun $bun is required (.bun-version) for reproducible bundles; found $(bun --version)."
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' || die "Node 22 or newer is required; found $(node --version)."
[ -z "$(git status --porcelain --untracked-files=all -- . ':(exclude)docs/receipts')" ] ||
  die 'commit or set aside local changes first; a receipt attests one commit.'
# Hosted CI never reuses a running server (CI=1 below); a stray one would test someone else's build.
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"${SCOPE_PREVIEW_PORT:-8787}" -sTCP:LISTEN -t >/dev/null 2>&1; then
  die "port ${SCOPE_PREVIEW_PORT:-8787} is in use; the browser tests must start their own preview server."
fi

sha=$(git rev-parse HEAD)
receipt=docs/receipts/ci-$(git rev-parse --short=7 HEAD).json
zip=$(node -p 'const p = require("./package.json"); `${p.name}-${p.version}.zip`')
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
rm -f "dist/$zip" "dist/$zip.sha256"

failed=
# run <step> <command...>: show and keep the output; later steps are skipped after the first failure.
run() {
  step=$1; shift
  [ -z "$failed" ] || return 0
  printf '\n==> %s\n' "$*"
  { rc=0; "$@" 2>&1 || rc=$?; echo "$rc" > "$tmp/$step.rc"; } | tee "$tmp/$step.log"
  [ "$(cat "$tmp/$step.rc")" = 0 ] || failed=$step
}
browser_tests() { CI=1 PLAYWRIGHT_JSON_OUTPUT_FILE="$tmp/browser.json" bunx playwright test --reporter=list,json; }
run install bun install --frozen-lockfile
run check bun run check
run bundles git diff --exit-code -- panel/main.js service/main.js background/main.js
run browsers bunx playwright install chromium webkit
run browser browser_tests
finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)

mkdir -p docs/receipts
RECEIPT=$receipt SHA=$sha ZIP=$zip STARTED=$started FINISHED=$finished FAILED=$failed LOGS=$tmp \
MACOS="$(sw_vers -productVersion) $(uname -m)" BUN_VERSION=$(bun --version) node --input-type=module <<'JS'
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const env = process.env;
const text = file => existsSync(file) ? readFileSync(file, 'utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '') : '';
const digest = file => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
const last = (log, pattern) => { const all = [...log.matchAll(pattern)]; return all.length ? Number(all.at(-1)[1]) : null; };
// bun test ends with " N pass", " N fail", " N error" (unhandled errors, when any) and "Ran N tests across M files."
const check = text(`${env.LOGS}/check.log`);
const ran = last(check, /^\s*Ran (\d+) tests? across/gm);
const pass = last(check, /^\s*(\d+) pass\s*$/gm), fail = last(check, /^\s*(\d+) fail\s*$/gm);
const unit = ran !== null && pass !== null && fail !== null && pass + fail <= ran
  ? { pass, fail: fail + (last(check, /^\s*(\d+) errors?\s*$/gm) ?? 0) } : null;
let browser = null;
try {
  const { stats, config } = JSON.parse(readFileSync(`${env.LOGS}/browser.json`, 'utf8'));
  browser = { pass: stats.expected, fail: stats.unexpected, flaky: stats.flaky, skipped: stats.skipped, projects: config.projects.map(project => project.name) };
} catch {}
const receipt = {
  kind: 'local-macos-leg',
  hosted: false,
  note: 'Local run of the macOS leg of .github/workflows/ci.yml. This is NOT hosted CI: the Linux leg did not run.',
  result: env.FAILED ? 'fail' : 'pass',
  ...(env.FAILED ? { failedStep: env.FAILED } : {}),
  sha: env.SHA, bunVersion: env.BUN_VERSION, nodeVersion: process.versions.node, os: `macOS ${env.MACOS}`,
  steps: ['bun install --frozen-lockfile', 'bun run check', 'git diff --exit-code -- panel/main.js service/main.js background/main.js',
    'bunx playwright install chromium webkit', 'CI=1 bunx playwright test (chromium, webkit)'],
  unit, browser,
  bundles: { panel: digest('panel/main.js'), service: digest('service/main.js'), background: digest('background/main.js') },
  zip: existsSync(`dist/${env.ZIP}`) ? { name: env.ZIP, sha256: digest(`dist/${env.ZIP}`) } : null,
  startedAt: env.STARTED, finishedAt: env.FINISHED,
};
writeFileSync(env.RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
JS

[ -z "$failed" ] || die "FAIL at step '$failed'; see $receipt (local macOS leg, not hosted CI)."
printf '\nci-local: PASS; wrote %s (local macOS leg, not hosted CI).\n' "$receipt"
