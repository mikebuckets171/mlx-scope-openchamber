# MLX Scope 3.0 verification

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
- The original performance plan calls for paired representative real inference runs with Scope enabled/disabled and
  investigation of a repeatable median slowdown above 2%. Component budgets and synthetic protocol streams do not
  establish that comparison. Its qualification status must be reported separately.
- The planned eight-hour stability soak is waived. Short automated lifecycle, hidden-view and resource checks remain;
  they do not establish long-duration stability or sleep/wake coverage.

Local development receipts live outside the repository until scrubbed and finalized. Never commit chat content, private
paths, provider credentials, raw session IDs or uncontrolled screenshots of the user's conversations.

## October 8 candidate receipt

- Full check passed: 1,725 Bun tests, 38 Node companion tests, type checking, privacy scanning, reproducible bundles,
  package allowlist and clean extracted service/runtime smoke. The candidate stayed within the enforced 3.0 bundle
  ceilings; CPU/RSS ceilings are unchanged.
- Chromium/WebKit local broad coverage produced 378 passing cases and four outdated presentation expectations. The two
  test files were corrected to assert exact completed-result facts and concise copy; all 92 affected and completion
  cases then passed. The first Linux CI run passed 379 cases and found three real enlarged-text layout failures.
  CSS repairs bound the Session grid, stack its controls at narrow text-relative widths and reserve room for wrapped
  Engine facts. The repaired candidate passed all 382 Linux CI browser cases. An independent review corrected an
  ineffective font override in the additional stress harness and found a 200% mixed-activity overlap and long failure
  guidance. The final enlarged-text layout reserves a wrapped header within the host's 320 px clamp, and concise error
  copy retains the failure and next action. Canonical regressions cover mixed activity at 150%/200% text and narrow
  widths. All 44 layout cases, 10 failure/copy cases and 48 scenes with verified applied fonts passed, including six
  enlarged full-view completion transitions. [PR 18 CI](https://github.com/mikebuckets171/mlx-scope-openchamber/pull/18/checks) verifies the final candidate;
  failed checks must pass before publication.
- Final visual evidence covers 32 scenes and 21 exact goldens, including narrow layouts, both themes, enlarged text,
  keyboard controls, tool waits, interruption, completed results and cloud estimates. An independent 42-case final
  layout/lifecycle review found no open issue.
- Installed OpenChamber 2.2.0 rendered the Session sidebar, rail and full-page Live/History controls. The sidebar was
  inspected in light/dark modes, including 150% host text. Real results remained labeled Last engine averages.
  The update preserved all 14 existing storage entries before subsequent normal collection. A host shutdown timeout
  required recovery after its OpenCode process had already stopped; the cause is unqualified, and this is not a
  long-duration host-stability receipt. The inference runtime was not restarted.
- The actual bundled OpenCode 2.0.25 passed isolated local and remote protocol smoke, including matching, calibration,
  completed timing and hidden shutdown. Setup preservation/rollback and companion absence/version mismatch are covered
  by tests. The optional companion was not enabled in the user's live configuration for this receipt.
- Service plus children: maximum active CPU 1.180%, idle 0.595%, glance 0.578% of one core; service peak RSS 80.1 MiB.
  Isolated Chromium renderer main-thread CPU was 0.104–0.678%; hidden views made zero snapshot requests and settled
  within 0.051 MiB of retained heap. These renderer measurements exclude aggregate browser/WebView, GPU and RSS costs.
  Companion probes separately measured median incremental CPU of 0.064% idle, 0.960% visible and 0.088% hidden,
  with zero hidden chat-telemetry writes. The separately configured legacy Splash progress observer is outside that
  probe. Component measurements are not summed into an aggregate host claim.
- One bounded, uncontaminated 128-token real inference with monitoring enabled passed native counter qualification.
  The enabled/disabled median comparison remains unqualified alongside interactive user workloads; no claim of a
  slowdown at or below 2% is made. Publication follows the maintainer's latest instruction to inspect the installed
  app and publish. The eight-hour soak is waived; sleep/wake and long-duration stability remain unqualified.

Final panel SHA-256: `b469672bff7c17e67d18714852298a1de43f4fc60c43aa56bf3a73b6a70b6b8d`.
Final stylesheet SHA-256: `8dd79ce03db2d5cbec92c0d10e29c5da362b0bcfe530247ac3283623c70bbd9b`.

## Publish and verify

After verification, finalize a scrubbed receipt here, review the final diff, merge the candidate and push `v3.0.0`.
The existing tag workflow runs CI and publishes the named ZIP with its checksum. Download that asset, verify SHA-256
and perform a clean installation. GitHub-generated source archives are not install packages.

Only then update the personal native OMLX Scope from 0.7.4 commit `9d69602`, preserving its bundle identity, preferences
and Keychain entries. Verify `/Applications/OMLX Scope.app` and the running executable before moving obsolete
OMLX/RapidScope application bundles to Trash. Source, Git history, settings, recorded data and SiliconScope stay intact.
