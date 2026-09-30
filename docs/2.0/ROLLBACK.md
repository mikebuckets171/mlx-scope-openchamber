# MLX Scope 2.0 · rollback runbook

This runbook is written from the plan (§7), `docs/2.0/SPIKES.md`, `docs/2.0/RELEASE-RUNBOOK.md` and the OpenChamber
SDK 2.0.4 documentation. Steps marked **verified in Stage 12** rest on host behaviour that the Stage 12 git-update
rehearsal (plan §8.10, run with `docs/2.0/REHEARSAL.md`) exercises before G6; its receipt records the outcome, and this
file is corrected if the host behaves differently.

Use this runbook when a published 2.0.x release misbehaves for users. It has two paths:

| Situation | Path |
|---|---|
| Anything that a patch release can fix: a wrong reading, a broken view, a bad label, a slow probe | [Fix forward with 2.0.1](#1-fix-forward-with-201) |
| Scope is unusable or unsafe on 2.0.x and a fix will take a while. Examples: every surface is blank, a runtime is started or woken, a private value reaches a share path, storage is being damaged, overhead runs away | [Severe case: pin the legacy line](#2-severe-case-pin-legacy16x) while the fix is prepared |

Never delete, move or re-push a published tag, in either path.

## 1. Fix forward with 2.0.1

**Why the version must increase.** OpenChamber offers **Update** to a git install only when the origin's `package.json`
`version` is newer than the installed one (SDK `DOCUMENTATION.md`, "Zip / git install"). A fix published under the same or
a lower version never reaches existing git installs. ZIP installs never update themselves; those users install the newer
ZIP from Releases.

**Maintainer steps**
1. Branch from the released tag, for example `hotfix/2.0.1` from `v2.0.0`.
2. Fix the problem and add a regression test.
3. **Do not add or remove any exec entry or capability, and do not change `engines`.** OpenChamber rechecks the grant for
   an exact match, so any change sends every install back to **Needs approval** (plan §6: no exec or capability change in
   2.0.x). If the broken part depends on an exec entry, disable it in code and leave the entry in the manifest until 2.1.
4. Keep storage compatible. 2.0.1 must read everything 2.0.0 wrote (`meta.v2`, `pref.v2`, `ledger.v2.*`, `baseline.v2`,
   `capture.v2.*`). If a row format has to change, bump `meta.v2.schema` and migrate forward; never delete user data
   because it failed to parse.
5. Set `version` to `2.0.1`, add a `## 2.0.1` changelog section, and rebuild the bundles with Bun 1.4.2
   (`.bun-version`).
6. Release it: push the tag and let `release.yml` publish, or follow `docs/2.0/RELEASE-RUNBOOK.md` under a written owner
   waiver. Merging to `main` is what git installs without a pin follow, so merge, tag and release in one sitting.
7. Check the Latest label sits on 2.0.1 (`gh release list --limit 3 --json tagName,isLatest`). If not,
   `gh release edit v2.0.1 --latest`.

**What users do:** Settings → Extensions → MLX Scope → **Update**. Git updates stop the running service before the swap
(OpenChamber host documentation; SPIKES S11), so no restart is needed. If a view still shows "contract mismatch", pause
MLX Scope and resume it in Settings → Extensions. Pause and resume restarts the service (verified in Stage 12); SPIKES
S11 showed that approval alone does not restart it.

## 2. Severe case: pin `legacy/1.6.x`

The legacy line is `legacy/1.6.x`, cut from `v1.6.1`. It takes security and correctness fixes only, and it is also the line
for OpenChamber 1.24.x–2.0.3 hosts.

**Maintainer steps**
1. Make sure the branch is public and its head is a published release. `legacy/1.6.x` is cut from `v1.6.1` and pushed at
   owner gate G7, with the 2.0.0 release; before G7 it exists only in the maintainer's local repository.
2. Say so where users look: a short notice at the top of the README and in the GitHub release notes of the current 2.0.x,
   with the pin URL below and the reason.
3. Prepare the fix-forward release (section 1). When it is out, remove the notice and tell pinned users how to return.
4. A legacy release made after 2.0 is published with `--latest=false` (`RELEASE-RUNBOOK.md`, "Legacy line").

**What users do**
1. Install the pinned line in Settings → Extensions:

   ```text
   https://github.com/mikebuckets171/mlx-scope-openchamber#legacy/1.6.x
   ```

   How an existing 2.0 git install switches to the pin is verified in Stage 12. OpenChamber stores zip and git installs by
   extension id (`mlx-scope`), and uninstalling deletes the extension's storage (SDK `API.md`, "Extension storage"). If
   the rehearsal shows the pin can only be applied after an uninstall, the v1 captures and the reply history are lost that
   way, and this step must say so, with the Clear-first advice below, before anyone is told to pin.
2. Approve the 1.6 permission set when OpenChamber asks. 1.6 declares `/usr/bin/vm_stat`, `/usr/sbin/sysctl` and `lms`,
   which differs from 2.0's set, so a new approval is expected (the dialog is verified in Stage 12).
3. If the panel shows a service error right after the switch, pause MLX Scope and resume it. A still-running 2.0 service
   answers a 1.6 panel's `/snapshot` with `410 contract_mismatch`, which 1.6 shows as a service error rather than
   explaining it (how 1.6.1 renders the 410 is verified in Stage 12).
4. To return to 2.x later, install the unpinned URL again and approve the 2.0 set.

## 3. What data survives

Scope's saved data lives in OpenChamber extension storage for the id `mlx-scope`, on the computer that runs the
OpenChamber server. The 2.0 service keeps everything else in memory and writes no files (plan P5).

| Data | Keys | After a 2.0.x update | After rolling back to 1.6.x |
|---|---|---|---|
| View preferences and the selected connection | `view.*`, `connection.selection` | Kept and used. `view.compact` now means the ≤160 px glance view | Kept and used as before |
| 1.6 saved observations | `observation.v1.*` | **Kept untouched through every 2.0.x release** (at most 48 KiB). 2.0 copies them to `capture.v2.*` and leaves the originals. Deleting them is a 2.1 decision | Visible again. Anything saved in 2.0 is not |
| Captures saved in 2.0, and the migrated copies | `capture.v2.*` | Kept | Invisible to 1.6 |
| Reply history, baselines, 2.0 preferences | `ledger.v2.*`, `ledger.v2.models`, `baseline.v2`, `meta.v2`, `pref.v2` | Kept | **Invisible to 1.6.** It stays in storage, still counts toward the 2 MiB namespace limit, and 1.6 has no control that deletes it |
| Trend ring, completions, alert log | service memory only | Lost whenever the service stops, including on update | Lost |

**Implications**
- To remove reply history before rolling back, use History → Storage → **Clear** in 2.0 first. After the rollback only an
  uninstall removes it.
- The ledger cap (1,280 KiB, SPIKES S5) keeps at least 128 KiB of the 2 MiB namespace free, so 1.6's saved observations
  still fit. Storage accounting enforces the cap; the rehearsal checks it on the real host (verified in Stage 12).
- Updating from 1.6.x to 2.0.x a second time: `meta.v2.migratedAt` records the first migration. Whether observations
  saved during the rollback are picked up then is the ledger migration's rule (`panel/history/migrate-v1.ts`), and the
  rehearsal's severe path records what happens (verified in Stage 12).
- **Uninstall deletes the whole namespace** (SDK `API.md`: "Uninstall deletes the namespace, including for folder
  installs"): v1 and v2 keys alike. Backups of the OpenChamber data folder, for example Time Machine, keep their own
  copies.

## 4. Owner-side steps (the maintainer's own Mac)

These files are outside this repository and belong to the maintainer's local setup. This runbook describes the change;
it does not edit them.

**`~/CodexWork/splish-local/RUNBOOK.md`, section "MLX Scope (OpenChamber extension)" (about lines 124–127)**
- Today it records the installed version as 1.6.0 and gives an `rsync -a --checksum --delete` rollback to a 1.4.0 backup
  under `~/.config/opencode/backups/`.
- When the owner's install moves to 2.0:
  - record the installed version, its install source (git, unpinned), and the date `setup_check.sh` verified it;
  - before updating, take a fresh `--checksum` backup of `~/.config/openchamber/extensions/mlx-scope/` and name it for the
    1.6.x version it holds;
  - make "Update to the next 2.0.x" the first rollback step and "reinstall pinned to `#legacy/1.6.x`" the severe one,
    pointing at this file;
  - keep the rsync restore only as a last resort, and note its limits: it restores files, not the approval, so OpenChamber
    is expected to ask for approval again and to keep offering Update because the origin is newer. Storage is not touched
    by rsync. Both are verified in Stage 12.

**`~/CodexWork/splish-local/tools/setup_check.sh` (about lines 45–50)**
- It reads the version from `~/.config/openchamber/extensions/mlx-scope/package.json`, prints the install source from
  `extensions.json`, and warns unless `gh release view v<version>` finds a published release.
- Check, without editing:
  - after a pin to `#legacy/1.6.x`, the reported version must be a published legacy release (1.6.1 today); a pin to an
    unreleased legacy commit will warn;
  - the Stage 12 betas install as a separate extension, `mlx-scope-beta`, which this check does not look at;
  - between the owner's switch to an unreleased 2.0 build and the public 2.0.0 release, the check warns by design.

**`~/CodexWork/splish-local/tools/vision_check.sh` (line 10)** reads `docs/design/mock-shots/live-dark-1160.png` from the
`mlx-scope-splash` worktree. Keep that file (plan §7 and §10).

## 5. Before G6

- [ ] The Stage 12 rehearsal (plan §8.10) also runs the severe path in the isolated instance described in
      `docs/2.0/REHEARSAL.md`: switch a 2.0 install to `#legacy/1.6.x`, then back, and record whether v1 captures and the
      ledger survive each step.
- [ ] Every "verified in Stage 12" line above matches the rehearsal receipt, or is corrected.
- [ ] `legacy/1.6.x` is pushed (G7) with the release, so the README's pin resolves the day 2.0.0 ships.
