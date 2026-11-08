# Contributing

MLX Scope is a community-maintained project. Review, merging and releases depend on maintainer availability and are not
promised. Community forks and adaptations are welcome under the MIT license, and so are issues and pull requests. The
guidance below also applies to anyone carrying the project forward.

Use Bun 1.4.2 and Node 22 or newer. Bun 1.4.2 is required for reproducible bundles: the committed `panel/main.js` and
`service/main.js` are its output, and another version can change them (1.3.14 renames minifier
identifiers), which fails CI's tracked-bundle check. `.bun-version` and `packageManager` in `package.json` pin it, and CI
installs the version in `.bun-version`.

```sh
bun install --frozen-lockfile
bun run check       # about 30 s: types, privacy scan, unit/contract/fixture tests, helper tests, build, guest-check, package verification
bun run test:smoke  # about 45 s: the @smoke browser set, 16 tests in Chromium and WebKit
```

Those two run on every change, and hosted CI repeats them on Linux and macOS before a release. `check` type-checks, scans
committed files, runs the unit, contract and fixture tests, builds both bundles, runs OpenChamber's own `guest-check`, and
verifies the install archive: the SDK 2.7.0 manifest, the frozen permission set, the two-way exec match, bundle ceilings (panel
295 KB, service 268 KB: the measured 5.1 bundles × 1.05), the exact panel CSP, host-only code in guest bundles, that every file the
chat-speed helper imports ships with it (OpenCode loads it from its own folder with nothing else reachable), and a start of the
extracted service under Node without `node_modules`. It writes no ZIP when a check fails. `test:smoke` builds the panel and starts
its own preview server; set `SCOPE_PREVIEW_PORT` to run several checkouts side by side. A preview server left running by another
checkout is never reused unless you set `SCOPE_REUSE_PREVIEW=1`, because it would silently test that checkout's build.

The rest are tools you reach for when a change calls for them, not steps every release repeats:

| When | Run |
|---|---|
| A broad UI change | `bun run test:browser` (all 600+ cases, about 17 min; hosted CI runs it only when started by hand) and `bun run test:goldens` (the pixel and text goldens, Chromium on macOS) |
| The manifest, permissions or how the helper is delivered changes | `bun run test:host`, and `bun run test:host -- --migrate <previous tag>` when an older install can exist: it runs the installed OpenChamber desktop app's own web server in a throwaway profile, installs the release ZIP through Settings, approves it, and checks the helper loads and every surface opens. It hashes your own OpenCode settings before and after and fails if they changed. No model, no prompt |
| A new OpenCode release | `node bridge/opencode/protocol-smoke.mjs <opencode>` (add `--remote`), `protocol-ws-smoke.mjs`, `protocol-compaction-smoke.mjs`, and `bun bridge/opencode/protocol-migration-smoke.mjs <opencode> <tag>` against an isolated released binary, then `bun run qualify:compatibility` |
| A cost or CPU claim | `bun run overhead` measures the service and every child it spawns |

Do not skip a failing platform or relax a real deadline to make a test pass. `bun run preview` starts a local server with synthetic
readings (`tests/browser/host.html`, an emulation of the OpenChamber host: panel, page and Work Status surfaces, setHeight, badge
and toast recorders, lifecycle replays, storage limits and lease handovers). It does not connect to a real runtime. Keep both
bundles synchronized with source because repository installation uses these built files.

**Development seams.** An explicitly launched service reads `MLX_SCOPE_BASE_URL`, `MLX_SCOPE_API_KEY`, `MLX_SCOPE_MODEL`,
`MLX_SCOPE_RUNTIME` and the `OPENCODE_*` variables described in [Configuration](docs/CONFIGURATION.md). The overhead
harness and service tests use them; they are not extension settings.

## Upgrade qualification

After building, `bun run qualify:compatibility` checks synthetic host, bridge and storage behavior, source/bundle
consistency, privacy and the reproducible package. `--candidate` labels a proposed OpenCode version; it never launches
that version or grants it support. Save receipts outside the repository. Browser, resource and native-runtime proof
remain separate gates; see [Compatibility](docs/COMPATIBILITY.md).

## Changes

Describe the user-visible problem and the relevant verification. Add a regression test when it proves behavior. Check
narrow, compact, full-page and Work Status layouts, light/dark/custom themes, keyboard interaction, focus, and reduced
motion for UI changes. Interactive controls should survive telemetry updates.

Use documented OpenChamber APIs only. Preserve observer-only operation, append-only draft sharing, left-out values and
Engine readings unless a reply is labelled. Comparisons are observations, not controlled benchmarks or
successful-completion records.

**Permissions.** A patch release never adds or removes an exec entry or a capability: any change re-prompts every install. A new
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

1. Update the version, the CHANGELOG entry (the release workflow publishes it as the notes, and fails without one) and the docs
   the change touches. A change to the manifest, a permission or how the helper is delivered also updates the approvals table in
   the README.
2. Run `bun run check` and `bun run test:smoke`, plus `bun run test:host` when the step above applies. The CHANGELOG says what
   was checked and what was not; there is no separate receipt.
3. Push the branch and open a pull request. Hosted CI repeats `check` on Linux and macOS and the smoke set on both browser
   engines. Merge when it is green.
4. Tag the merged commit `v<version>` and push the tag. The workflow checks again, then publishes the verified ZIP with its
   SHA-256 file and moves the `release` branch, which Git installs follow, to exactly that ZIP's contents. It never releases
   ordinary pushes. A fix to the `legacy/1.6.x` line after 2.0 is released with `--latest=false`. GitHub source archives are not
   install packages. Release screenshots must identify synthetic data when used.

Installing a ZIP over an existing Scope makes OpenChamber delete its stored data (History, baselines, preferences), so test
installs belong in a throwaway profile (`OPENCHAMBER_DATA_DIR`), which is what `test:host` does.
