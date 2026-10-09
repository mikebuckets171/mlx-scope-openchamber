# MLX Scope 3.1 candidate verification

The 3.1.0 candidate adds automatic source discovery, one Connections screen, optional managed media tracking, a dedicated Media view, and circular phase progress. It is installed locally in OpenChamber 2.2.0. Public publication is a separate release step; the public main branch and release tags remain unchanged.

## Correctness and installation

- The final production bundles passed type checking, privacy scanning, 1,782 Bun tests, 54 Node companion tests, and 15 Python helper tests. Existing runtime adapter and Splash progress fixtures remain covered.
- Media fixtures exercise waiting, measured and indeterminate progress, phase changes, ownership, simultaneous jobs, stale/disconnected sources, backend restarts, failure, completion, and scoped cancellation races. Percentages remain local to their reported phase or node. Unsupported cancellation stays unavailable.
- Guided setup fixtures cover detection, partial capabilities, ambiguous installation locations, missing approval, helper installation/update/removal, configuration conflicts, rollback, and activation pending the owner's next launch. Metadata-only Connections reads do not probe runtimes or start collection.
- The ZIP contains 36 allowlisted assets. Reproducibility, archive safety, bundle ceilings, CSP, privacy boundaries, and byte-identical extracted files passed. Its extracted Node service starts without node_modules and passed authenticated routes, JSONC, runtime freshness, history, real macOS read-only probes, and shutdown checks.
- The installed Git update retained all 15 existing guest-storage entries unchanged before monitoring resumed. OpenChamber 2.0.4 remains the SDK and manifest compatibility floor; the candidate's native inspection used the installed 2.2.0 host.
- Cloud tracking now observes qualified WebSocket metadata as well as HTTP metadata. The actual released OpenCode 2.0.25 default OpenAI path passed with six synthetic calls on one reused socket, a native read-tool continuation, live estimates, three-step calibration, completed averages, and hidden cleanup. No real provider was called.
- An actual 2.0.25 server loaded the managed 3.0.0 → 3.1.0 update through its configuration watcher while an existing synthetic response finished. The server stayed running and the request was not duplicated. Fixtures preserve JSONC comments, other options and plugins, make unchanged updates byte-stable, and verify rollback and registration-failure cleanup.

## Design and motion

The installed Session sidebar was inspected in light and dark themes with a real existing video job. The ring showed the backend's latest sampling percentage, elapsed time, ownership, and the report's age. A stale percentage remained still and visibly historical. Connections detected local runtime configuration, loaded chat tracking, and the existing video queue. Rail and full-page navigation were inspected without restarting the host or submitting a generation.

Focused Chromium/WebKit verification passed 58 circle/layout cases and 70 setup/metadata cases. These cover Session, rail and full-page fixtures, narrow layouts down to 260 px, enlarged text, keyboard interaction, phase resets, hidden views, and Reduce Motion. Enlarged-text and reduced-motion claims come from browser fixtures rather than native operating-system preference changes. Public screenshots use synthetic jobs and contain no conversations.

Only changed live digits roll for approximately 160 ms. Valid circular progress eases directly between received values in the same phase. Neither motion invents intermediate readings. Completion, cancellation, stale observations, hidden views and Reduce Motion stop animation.

## Resource evidence

The [service receipt](../receipts/overhead-3.1.0.json) uses the frozen initial 3.1 media bundle (`c546c680`) on an Apple M5 Pro with Node 22.23.1. The later cloud repair changes managed chat-helper setup and readiness; media/runtime collection code is unchanged. These service CPU figures were not remeasured against the updated setup bundle. The CPU-only stress profile has four media sources, four simultaneous view requests, 73 fixture records bounded to 64 jobs, and a synthetic oMLX runtime. Active and glance media reads occur every two seconds; terminal-only idle reads occur every five seconds. Each measured phase lasts 30 seconds after settling.

| Measurement | Result | Retained ceiling |
| --- | ---: | ---: |
| Active service and children | 1.736% of one core | 1.9% |
| Idle service and children | 0.633% | 0.68% |
| Glance service and children | 0.611% | 0.68% |
| Peak service RSS | 82.297 MiB | 132 MiB |

Child CPU uses exact per-command wait4 readings and includes the measurement wrapper's own CPU. All 35 commands were accounted for, none crossed a phase boundary, and aggregate CPU reconciled within 0.005 seconds of the time tool's rounded reading. Earlier pooled estimates and failures are retained in the local evidence; pooling short-lived full-view and glance commands assigned unrelated diagnostic cost to the glance window. This instrumentation correction changed neither the product bundle, workload nor ceilings. The development wrapper is outside the installed package.

The 75-second hidden window made zero media/runtime requests, spawned no children, and settled to 0.003% service CPU. Every source had at most one concurrent request. The isolated service wrote no unexpected files. RSS is sampled and does not establish a long-duration growth rate.

The actual Python helper route, including private-token validation, filtering and serialization, measured 0.031239% of one core at a two-second fixture cadence, with no background work. That excludes ComfyUI's existing process, HTTP transport, GPU work and base RSS.

The circular UI's Chromium main-thread fixture measurements were 1.340% for Session, 1.869% for Live, 1.169% for Media, 0.724% for Live with Reduce Motion, and 0.009% hidden. Visible media updates were deliberately supplied once per second. Hidden views made zero LLM/media/setup requests and zero digit animations. These include the synthetic SDK host and exclude compositor/GPU/browser-process CPU and native WebView process RSS. After measurement, only the footer literal changed from “Media updated” to “Sources checked”; motion behavior was unchanged.

The updated [companion receipt](../receipts/companion-3.1.0.json) compares three alternating enabled/disabled pairs with four concurrent synthetic chats in two distinct locations. Median paired incremental CPU was 0.044% of one core while idle, 1.198% while visible, and 0.125% while hidden with fixture output continuing. The visible worker including its synthetic producer used 1.521% versus a 0.356% baseline. Median paired peak-RSS difference while visible was 6.97 MiB. One writer stayed below 2,833 bytes; all four live readings were observed, and hidden subscriptions, sampled events, telemetry writes and heartbeat writes stopped. These are isolated Node-worker measurements, not whole-OpenCode RSS or inference overhead.

These component checks do not establish representative enabled/disabled inference slowdown, every real cloud provider's behavior, long-duration stability or sleep/wake behavior. The companion protocol remains OpenCode 2.0.25; unsupported protocols disable estimates while runtime monitoring continues.

## Personal workflow activation

The existing local render remained active and was observed read-only. Additional LocalVideo and Qwen producer changes were prepared against preserved current files and verified with CPU-only fixtures. They remain staged while generation is active. No worker, OpenCode, OpenChamber or ComfyUI restart was performed. Local video monitoring already reads the existing queue; the additional producer fields and Qwen live tracking activate after the staged integration and the owners' normal next launch.

The helper and producer staging checks passed 40 new fixtures. The existing Qwen reliability suite passed 18 cases; two chat-pause fixtures fail identically against the untouched original. Those failures remain disclosed and unchanged. Native OMLX Scope media support is outside this candidate.

## Candidate archive

`mlx-scope-openchamber-3.1.0.zip` is 482,169 bytes. Its SHA-256 is `e5d4ee178e88ebf6007c676b584ab0f8776252ccb112d32482f25414080a9997`.

Current packaged service: `2bb8d22089d041bffaf8ffcb7960d38d4221d5ef837a3a426c3c208af334e10e`.

Installed panel: `ab41f5e4d186017aa55088c74f4bcd4b7d38905bcf9417fd2bb02366873c5d27`.

Stylesheet: `8d450fd6494c44a4cb09e6bde455af6892fb81166ad086c4b766e38449bf5bc0`.
