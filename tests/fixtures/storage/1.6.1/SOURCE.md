# Extension storage fixtures · MLX Scope 1.6.1

**What this folder is:** the `observation.v1.*` records MLX Scope 1.6.1 writes to OpenChamber extension storage (Saved
observations), and the `capture.v2.*` records the 2.0 migration (`panel/history/migrate-v1.ts`) must produce from them.

| File | What it holds |
|---|---|
| `observation-v1.json` | The whole namespace after three saves, exactly as 1.6.1 stored it: an oMLX prefill snapshot, a held Splash snapshot, and a 30 s capture with a pinned reference (`comparison`). |
| `capture-v2.golden.json` | The migration's output for those three records, keyed by the deterministic `capture.v2.<savedAt36>.<hash4>` key. |
| `generate.ts` | The script that wrote `observation-v1.json`. |

**Provenance**
- Written by the 1.6.1 panel's own code: `SavedObservations.save`, `snapshotObservation`, `captureObservation` and
  `PerformanceCapture` from tag `v1.6.1` (`290a39eb86ec9d6ba00ca558ea88d4c74de728a8`), `panel/saved.ts` and `panel/capture.ts`,
  run through `parseTelemetrySnapshot` from the same tag. Nothing in `observation-v1.json` was edited by hand.
- To regenerate: `git archive v1.6.1 | tar -x -C <dir>`, link `node_modules`, copy `generate.ts` into `<dir>`, and run
  `bun generate.ts` there. The record keys end in 32 random hex digits (1.6.1's `crypto.getRandomValues` suffix), so a
  regenerated file differs only in those suffixes.

**Synthetic only.** Every input is made up: `Example-27B-4bit` and `Example-35B-A3B-4bit` are allowlisted placeholder model
names, and 1.6.1 never stores them (its allowlist keeps numbers only, which the files show). Memory figures were chosen as
exact binary sizes so the GiB → bytes conversion (×2³⁰) is checkable by eye: 1.6.1 stored `memory: 29.999999999999996`
GiB for a 32,212,254,720-byte reading, and the migration restores the integer.
