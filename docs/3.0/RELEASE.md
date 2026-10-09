# MLX Scope 3.0 release gates

This branch is a release candidate built from public 2.1.6 (`4298c03`). A version number in the candidate is not evidence
of publication. Keep public `main` unchanged until the verification below has a dated receipt.
The maintainer explicitly waived the eight-hour soak on October 8, 2026, and requested installed OpenChamber inspection
followed by public publication. Do not report a soak as completed.

## Required evidence

- Full type, fixture, privacy, unit, browser, bundle and clean ZIP checks. Keep all adapter and Splash progress fixtures.
- OpenCode 2.0.25 actual-protocol smoke: local and remote delivery matching, estimates, three-step calibration,
  completed averages and hidden shutdown. Provider-specific buffering and observable reasoning limits remain explicit.
- Real installed OpenChamber 2.2.0 Session/rail/page checks, both themes, keyboard use, narrow widths and larger text.
  Retain the 2.0.4 SDK/manifest floor and inherited host contract checks.
- Local upgrade preserving settings/history/captures, with and without the optional companion; setup rollback and removal.
- Fresh service + child CPU/RSS measurement under the existing ceilings (idle/glance ≤0.68% of one core, active ≤1.9%,
  service RSS ≤132 MiB), plus separately attributed renderer and companion cost. Hidden views issue no runtime requests.
- Paired representative real inference runs with Scope enabled/disabled. Investigate a repeatable median slowdown above
  2%; no unexplained regression may ship. Synthetic protocol streams do not satisfy this gate.
- The planned eight-hour stability soak is waived. Short automated lifecycle, hidden-view and resource checks remain;
  they do not establish long-duration stability or sleep/wake coverage.

Local development receipts live outside the repository until scrubbed and finalized. Never commit chat content, private
paths, provider credentials, raw session IDs or uncontrolled screenshots of the user's conversations.

## Publish and verify

After verification, finalize a scrubbed receipt here, review the final diff, merge the candidate and push `v3.0.0`.
The existing tag workflow runs CI and publishes the named ZIP with its checksum. Download that asset, verify SHA-256
and perform a clean installation. GitHub-generated source archives are not install packages.

Only then update the personal native OMLX Scope from 0.7.4 commit `9d69602`, preserving its bundle identity, preferences
and Keychain entries. Verify `/Applications/OMLX Scope.app` and the running executable before moving obsolete
OMLX/RapidScope application bundles to Trash. Source, Git history, settings, recorded data and SiliconScope stay intact.
