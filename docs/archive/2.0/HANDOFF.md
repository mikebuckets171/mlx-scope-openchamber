# MLX Scope 2.0 · hand-off (2026-09-29)

This hands the remaining 2.0 work from a local Claude Code session to a cloud session. Everything needed is on the branch `next/2.0` of `mikebuckets171/mlx-scope-openchamber`.

## Read first
- `docs/2.0/PLAN.md`: the approved plan.
  - Owner decisions 1–13; principles P1–P11; architecture; stages 0–13; gates.
  - The **G1 and S2 amendment boxes at the top of §5 override the body.**
- `docs/2.0/SPIKES.md`: verified platform, runtime, Mac and build facts, the G1 decisions, and the frozen permission set.
- `docs/design/2.0-contract.md`: the wire contract v2, implemented in `src/contract/*`.
- `docs/design/2.0-mock.html`, `docs/design/2.0-mock-shots/`, `docs/design/2.0-G2-DECISIONS.md`: the approved UI.
- `docs/2.0/INTERFACES.md`: module ownership and exported signatures for every remaining module. Stubs are already committed.
- `docs/2.0/FIXTURE-NOTES.md` and `tests/fixtures/<family>/<version>/SOURCE.md`: adapter notes and fixture provenance.
- `docs/2.0/RELEASE-RUNBOOK.md`, `docs/2.0/ROLLBACK.md` (draft), `docs/2.0/REHEARSAL.md` (Stage 12 isolated-instance procedure).

## Done
**1.6.1 hotfix: released.** No-wake `lms`, the v0 fallback, and per-connection LM Studio activity. It is on `main`, tagged `v1.6.1`, and installed on the owner's Mac.

**`main` CI green again.** The GitHub billing lock is lifted, and PR #8 pinned Bun 1.4.2.

**Stage 0: spikes.** All rows are settled. S2 attribution was measured live.
- The `sessions` capability is **dropped**, by owner decision.
- `pmset` is replaced by `notifyutil`.
- Splash uses `/status` only.
- llama-server follows the S7b polling rule.
- There is no GPU-limit alert.

**Stage 1: foundations.**
- Bun is pinned to 1.4.2.
- `scripts/scan-committed.ts` is a scrub gate that runs in `bun run check`.
- `scripts/ci-local.sh` runs the CI checks locally on macOS and writes a receipt.
- 21 clock-frozen **1.6 goldens** (text and pixels), run with `bun run test:goldens`.
- A descendant-aware overhead harness: `bun run overhead`.
- The G2 design mock, the v2 contract and the design decisions.
- The SDK is 2.0.4, with the engines floor unchanged until the flip.

**Fixture corpora** for oMLX 0.7 and 0.6.4, Splash 1.1 and 1.0.2, llama-server (b10519 and b6700), Ollama 0.40, LM Studio/Bionic and macOS host probes. All are synthetic, with canaries. They are included in `bun run test`.

**Stage 2a: contract v2 at 1.6 parity.** The 1.6 goldens pass unchanged.
- `src/contract/*` and a lossless 1.x → v2 converter.
- Service: registry, slot, scheduler, lease, marks, verdicts, `/v2/snapshot`; `/snapshot` returns 410.
- Panel: pure presenters, data client, IntersectionObserver-v1 visibility gate.

**Scaffold** for every remaining module (`docs/2.0/INTERFACES.md`). It type-checks and all tests pass.

**Docs drafts** (README, PRIVACY, SECURITY, ROLLBACK), marked for finalisation.

## Remaining
The owner chose **"fast, full scope"**: one parallel build, one integration, one review.

`docs/2.0/workflows/build.js` encodes it as 12 tracks:

| Track | Scope |
|---|---|
| svc-2b | registry fixes |
| svc-host | Mac telemetry |
| svc-history | ring, trend, completions, alerts |
| ad-omlx | oMLX adapter |
| ad-splash | Splash adapter |
| ad-lmstudio | LM Studio/Bionic adapter |
| ad-llama-ollama | llama-server and Ollama adapters |
| attribution | per-chat attribution |
| ledger | local reply ledger |
| ui-core | UI, including the Work Status Turn-stats replacement |
| ui-history | History and Captures tabs |
| scope-flip | `/scope`, manifest flip and docs |

After the tracks: integration, a three-lens review (correctness; principles and privacy; UI against the mock), and a fix pass. The owner approved all of these stages.

**Open decisions already made** (from the Stage 2a integration):
- Keep 1.6's provider-id rule (≤120 characters, no control characters).
- Remove the panel's 2 s cap on the service's `nextPollMs`.
- The "no fresh reading" deadline becomes max(6 s, 2 × nextPollMs + 1 s).
- `/health` returns the contract body.
- Accept `runtime=llama-server|ollama`.
- Route `unsupported_contract` through re-detection.

## Needs the owner's Mac (not the cloud)
**Stage 12** real-host qualification:
- install the beta in OpenChamber 2.0.4 desktop;
- the approval dialog;
- all surfaces render, with no blank or black frames;
- Work Status and the Turn stats swap;
- badge and toast;
- attribution on real local turns;
- no idle ledger writes;
- macOS pixel goldens;
- live oMLX, Bionic and Splash;
- real-host overhead and an 8 h soak;
- the git-update rehearsal (`docs/2.0/REHEARSAL.md`).

Then about **1 day of dogfooding** (owner-shortened from one week) and the independent review.

**Stage 13 release:**
- bump to 2.0.0 and the CHANGELOG;
- merge `next/2.0` → `main`, tag `v2.0.0` and release, in one sitting;
- push `legacy/1.6.x` (cut locally at v1.6.1; recreate from the `v1.6.1` tag if absent).

Merging to `main` **is** the public launch for git installs, so it waits for Stage 12.

## Rules that must hold
- **Observer only.**
  - GET-only runtime traffic, except the existing oMLX admin login.
  - Never inference, load or unload.
  - `lms` only with `LMS_API_SERVER_INFO_PATH` and `--port`.
  - llama-server `/slots` only per the S7b rule.
- **Service:**
  - no `setInterval`;
  - no disk writes;
  - never read `~/.config/openchamber/settings.json`;
  - exec through the argv allowlist only.
- **Privacy:**
  - Nothing class-A (PIDs, paths, keys, cookies, prompt text, session ids or titles, project names or folders) on the wire, in storage, in logs or in shares.
  - Model names never appear in shares, toasts, `/scope` or captures.
- **Honesty:** basis labels; "inferred" and "armed"; idle is a gap, never 0; never "VRAM"; no GPU-utilisation alert.
- **Committed files:** `bun scripts/scan-committed.ts` must pass. No owner-real data in fixtures, receipts or docs.
- **Bundles:** rebuild the tracked bundles with Bun 1.4.2 and commit them.
- **Publishing:**
  - Work branches and PRs may be pushed.
  - `main`, tags and releases wait for the owner's go after Stage 12.
  - Hosted CI now runs, so use it on PRs.
