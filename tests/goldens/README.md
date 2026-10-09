# Presentation goldens

`tests/goldens/2.0/` retains its fixture-contract path and now records the 3.0 presentation. The sidebar shows one
phase-relevant measurement, and the full view keeps engine readings and charts behind disclosures.

## What they are
- **Source of every reading:** the approved mock's v2 fixtures (`docs/design/2.0-mock-fixtures.json`), served as
  `/v2/snapshot` bodies by the 2.0 fixture host (`tests/browser/v2-host.html`, states from
  `panel/testing/mock-states.ts`). The host emulates OpenChamber 2.0.4: panel, page and Work Status surfaces, `setHeight`
  clamped to 24–320 px on the status surface, badge and toast recorders, `pref.v2` in session storage, and the `since`
  cursor. Nothing is converted from 1.x.
- **Text goldens** (`<case>.txt`, `status.txt`): a DOM dump of every visible element with an id, a `data-key`, a heading,
  a tab, a chip, a basis-labelled value or a live/img/note/progress role, with its aria and data attributes. They run on
  every platform. `status.txt` also records the height each Work Status state asked for.
- **Pixel goldens** (`*.png`): macOS only (plan §8.1), Chromium, 1 CSS px per pixel, the version masked. At most 60 files
  and 4 MiB in total (asserted by `goldens.spec.ts`).
- **Cases:** Live at 320 dark for 18 mock states; Server where the state has server cards; light at 320, the 1,160 px page
  and the Compact glance for a representative subset; the Session summary at 280 px for live, idle, alert,
  unavailable and non-local states, in both themes where it matters. The historical `status-tip` and
  `status-turnstats` filenames retain old preference cases to prove upgrades render the compact summary.

## How they stay deterministic
Each case runs in a fresh browser context with a paused fake clock (`2026-09-29 14:05 UTC`, `en-US`, `UTC`, reduced
motion) advanced in 500 ms steps. After every step a postMessage barrier (panel → host → panel, FIFO) waits until every
request the panel sent has been answered and handled, so the chart holds exactly the readings of those steps.

## Running and regenerating
```sh
bun run build:panel
bun run test:goldens                     # compare (SCOPE_PREVIEW_PORT moves the preview server)
GOLDENS_UPDATE=1 bun run test:goldens    # rewrite after an intended UI change; review the diff before committing
```
Regenerate only for an intended presentation change after checking the rendered result. Runtime readings in the
base fixtures remain engine-scoped. `v3-scope.spec.ts` separately verifies automatic chat following, persistent
measurement selection, labeled chat estimates, completion averages, cancellation, and late-response rejection.
