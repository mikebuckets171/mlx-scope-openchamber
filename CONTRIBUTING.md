# Contributing

This personal project is shared as a one-time release, with no planned ongoing
maintenance, updates, or support. Community forks and adaptations are welcome
under the MIT license. Issues and pull requests are welcome, but review and
merging are not promised. The guidance below also applies to anyone carrying
the project forward.

Use Bun 1.3.14 and Node 22 or newer.

```sh
bun install --frozen-lockfile
bun run check
bunx playwright install --with-deps chromium webkit
bun run test:browser
```

`check` type-checks, runs unit/integration tests, builds both bundles, verifies
the install archive, and starts its extracted service under Node without
`node_modules`. macOS checks exercise the real wired, compressed, and swap
commands within the production deadline. Browser tests cover Chromium and WebKit.
Do not skip a failing platform or relax a real deadline to make a test pass.

`bun run preview` starts a local development server with synthetic readings.
It does not connect to a real runtime. Keep `panel/main.js` and `service/main.js` synchronized
with source because repository installation uses these built files.

## Changes

Describe the user-visible problem and the relevant verification. Add a regression
test when it proves behavior. Check narrow, compact, and full-page layouts,
light/dark/custom themes, keyboard interaction, focus, and reduced motion for UI
changes. Interactive controls should survive telemetry updates.

Use documented OpenChamber APIs. Preserve read-only operation, append-only draft
sharing, missing values, and server-wide attribution. Captures are observations,
not controlled benchmarks or successful-completion records.

For adapter changes, cite the official endpoint and field definitions, then test
realistic contract fixtures and missing/contradictory data. Keep inventory separate
from residency and request telemetry. Do not infer speed from CPU, file size from
RAM, or context headroom from a model limit alone. Record live validation separately
from source review and fixture tests.

Explain any new dependency, permission, request, retained data, or metric meaning.
Use the existing sampling pipeline. Bound retained data and IO. Measure overhead;
a smaller ZIP alone does not establish efficiency. Never commit private readings,
credentials, local configuration, or generated test evidence. Preserve license
notices and clearly label synthetic screenshots.

## Releasing

1. Update the version, install asset name in the README, and concise changelog.
2. Run `bun run check:all` on macOS and inspect the resulting ZIP and checksum.
3. Install that exact ZIP in the supported OpenChamber host; review narrow and
   full-page views, themes, pause/resume, sharing, and the available local runtime.
   Record which runtimes were exercised; fixtures do not establish live validation.
4. Commit the source and matching bundles. Confirm CI passes and the checkout is clean.
5. Tag that commit `v<version>` and push the tag when publication is intended.

The tag workflow runs Linux/macOS checks and Chromium/WebKit tests, checks
tracked bundles, and publishes the verified install ZIP with its SHA-256 file.
It does not release ordinary pushes. GitHub source archives are not install
packages. Release screenshots must identify synthetic data when used.
