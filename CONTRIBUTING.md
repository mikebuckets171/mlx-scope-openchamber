# Contributing

MLX Scope is a community-maintained project. Review, merging and releases depend on maintainer availability and are not
promised. Community forks and adaptations are welcome under the MIT license, and so are issues and pull requests. The
guidance below also applies to anyone carrying the project forward.

Use Bun 1.4.2 and Node 22 or newer. Bun 1.4.2 is required for reproducible bundles: the committed `panel/main.js`,
`service/main.js` and `background/main.js` are its output, and another version can change them (1.3.14 renames minifier
identifiers), which fails CI's tracked-bundle check. `.bun-version` and `packageManager` in `package.json` pin it, and CI
installs the version in `.bun-version`.

```sh
bun install --frozen-lockfile
bun run check
bunx playwright install --with-deps chromium webkit
bun run test:browser
```

`check` type-checks, scans committed files, runs unit, contract and fixture tests, builds all three bundles, and verifies
the install archive: the SDK 2.0.4 manifest, the frozen permission set, the two-way exec match, bundle ceilings (panel
260 KB, service 170 KB, background 25 KB), the background page's CSP, host-only code in guest bundles, and a start of the
extracted service under Node without `node_modules`. macOS checks exercise the real memory commands within the
production deadline. Browser tests cover Chromium (the host's engine, the primary gate) and WebKit; `bun run
test:goldens` runs the pixel and text goldens in Chromium on macOS. `bun run overhead` measures the service and every
child it spawns. Do not skip a failing platform or relax a real deadline to make a test pass.

`bun run preview` starts a local server with synthetic readings (`tests/browser/host.html`, an emulation of the
OpenChamber 2.0.4 host: panel, page, Work Status and `/scope` background surfaces, setHeight, badge and toast recorders,
lifecycle replays, storage limits and lease handovers). It does not connect to a real runtime. `SCOPE_PREVIEW_PORT` moves
it, so parallel checkouts can each run their own. Keep the three bundles synchronized with source because repository
installation uses these built files.

**Development seams.** An explicitly launched service reads `MLX_SCOPE_BASE_URL`, `MLX_SCOPE_API_KEY`, `MLX_SCOPE_MODEL`,
`MLX_SCOPE_RUNTIME` and the `OPENCODE_*` variables described in [Configuration](docs/CONFIGURATION.md). The overhead
harness and service tests use them; they are not extension settings.

## Changes

Describe the user-visible problem and the relevant verification. Add a regression test when it proves behavior. Check
narrow, compact, full-page and Work Status layouts, light/dark/custom themes, keyboard interaction, focus, and reduced
motion for UI changes. Interactive controls should survive telemetry updates.

Use documented OpenChamber APIs only. Preserve observer-only operation, append-only draft sharing, left-out values and
server-wide readings unless a reply is labelled. Captures are observations, not controlled benchmarks or
successful-completion records.

**Permissions.** 2.0.x never adds or removes an exec entry or a capability: any change re-prompts every install. A new
command runs by absolute path through `service/lib/argv.ts`, with its argument list in the allowlist test, and waits for
a minor release.

**Adapters.** Cite the official endpoint and field definitions, then test realistic contract fixtures and
missing/contradictory data. Keep inventory separate from residency and request telemetry. Do not infer speed from CPU,
file size from RAM, or context headroom from a model limit alone. Label every value that isn't reported directly
(derived, observed, last observed, estimate). Record live validation separately from source review and fixture tests.

**Fixtures.** Runtime corpora live in `tests/fixtures/<runtime>/<version>/` with a `SOURCE.md` saying whether each file
is synthetic or captured and scrubbed. They must hold no home paths, usernames, keys, cookies, bearer tokens, real
request or session IDs, private addresses or your own model names; `bun scripts/scan-committed.ts` rejects home paths,
credentials, UUID-shaped IDs and private addresses, and runs in `check`. Plant a canary where a runtime can return private text, and test that it never
leaves the service.

Explain any new dependency, permission, request, retained data, or metric meaning. Use the existing sampling pipeline.
Bound retained data and IO. The service writes nothing to disk and never schedules repeating work. Measure overhead; a
smaller ZIP alone does not establish efficiency. Never commit private readings, credentials, local configuration, or
generated test evidence. Preserve license notices and clearly label synthetic screenshots.

## Releasing

1. Update the version, install asset name in the README, and concise changelog.
2. Run `bun run check:all` on macOS and inspect the resulting ZIP and checksum.
3. Install that exact ZIP in the supported OpenChamber host; review every surface, themes, pause/resume, sharing,
   `/scope`, and the available local runtimes. Record which runtimes were exercised; fixtures do not establish live
   validation.
4. Commit the source and matching bundles. Confirm CI passes and the checkout is clean.
5. Tag that commit `v<version>` and push the tag when publication is intended.

The tag workflow runs Linux/macOS checks and Chromium/WebKit tests, checks tracked bundles, and publishes the verified
install ZIP with its SHA-256 file. It does not release ordinary pushes. A fix to the `legacy/1.6.x` line after 2.0 is
released with `--latest=false`. GitHub source archives are not install packages. Release screenshots must identify
synthetic data when used.
