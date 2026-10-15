# Standard Scope interface — design QA

final result: passed

The user selected direction A, approved the polished precision interface, then required that presentation for everyone. There is one standard interface and no Classic/Next picker. Their later feedback specifically rejected the oversized number and typography; the current review applies to the quieter typography shown below. This is an agent review of actual browser-rendered synthetic fixtures, supported by automated checks. It is not a human usability study, an installed-host qualification, a literal concept-font match or a release approval.

## Findings

No actionable P0/P1/P2 remains in the reviewed current typography. Current ink checks pass 16/16 across both engines, and all 74 unique focused cases are closed through the mapped runs below. The current treatment uses a primary reading up to 80px, 56px at ordinary narrow width, weight 450 and restrained −.015em tracking. Session uses 38–40px before enlarged-text scaling, and Compact 28px. These replace the previous 120px, tightly tracked treatment. Numeral counters and decimal/comma spacing remain natural; the baseline unit reads with the quantity, while the measurement basis sits below it. Long readings stay whole on one line and units may move below them at enlarged sizes.

Resolved in this work:

- **[P1] Primary numeral ink was clipped.** The former static main readout retained hidden-overflow per-digit cells. Negative tracking shaved the 5, decimal and 6 in 25.6. A font-ink regression reproduced right-edge overrun of 1.3/1.9/2.7px even though DOM text and page overflow checks passed. Main, Session and Compact now use plain numeric text with no per-digit masks; a conservative width budget fits long values without changing the displayed reading. The [historical clipping receipt](docs/design/5.0/text-ink-regression-56d.json) records the failure and earlier eight-case fix. Current typography extends that regression to Session and Compact and passes 16/16. [Current ink receipt](docs/design/5.0/text-ink-regression.json).
- **User typography correction.** The unmasked 120px number remained visually oversized and compressed. The current smaller size, lighter weight, calmer spacing, baseline unit and separate basis replace it. The [former comparison](docs/design/5.0/historical-120px-comparison.png) is retained as historical evidence, not the accepted current typography.
- **[P1] Local navigation was blocked by service cards.** History/Captures now open local records during approval/version mismatch while Live retains the service card.
- **[P2] Back/Escape could return focus to hidden legacy controls.** Secondary views and Connections restore focus to their visible navigation/detail origin.
- **[P2] Session action errors lost their announcement role.** Failed actions retain `role="status"`, explanatory copy and clearing on chat switches.
- **[P2] Narrow/enlarged content could overflow or overlap.** Long model names are bounded; navigation wraps; brand/runtime and Mac fact label/value pairs stack when needed. Compact has its own scoped masthead sizing. These fixes preserve displayed information and enlarged type.

## Comparison and normalization

- **Source:** the unaltered [1536×1024 direction board](docs/design/5.0/selected-direction-board.png). The user selected left A, approximately x30/y69/720×894px. A generated concept has no authoritative CSS viewport, density or exact font family.
- **Current comparison input:** [A and the current actual instrument together](docs/design/5.0/standard-final-comparison.png), 1920×1390px. Both original images are embedded intact. CSS crops left A and uniformly displays its 720px panel at 920px; the actual [920×760 dark instrument](docs/design/5.0/typography-synthetic-instrument-dark.png) remains at its captured 1× density. No implementation bitmap is stretched. [Normalization manifest](docs/design/5.0/standard-final-normalization.json).
- **State and provenance:** actual shipping components in a synthetic preview, generating on local oMLX with request-average telemetry. The current documentation captures accumulated 96 seconds of observations and show an actual 90-second fixture trace. Model, values, waveform, elapsed time and runtime differ from the concept. Short-history responsive proofs show only their observed 2–3 seconds; no history was invented.
- **Acceptance target:** retain A’s continuous instrument, clear activity, primary rate, trace, supporting facts and Mac band. The user’s later typography feedback governs numeral scale and spacing. The concept’s illustrative Swap meter is omitted because Swap has no meaningful utilization denominator. This is a comparison of hierarchy and visual lineage, not a pixel-perfect claim.
- **Regions inspected in the combined input and current actual frames:** brand/navigation; phase/model/watch scope; numeral/unit/basis; chart/scale/time; Output/Elapsed; Mac facts; details and action controls. Current Session header and enlarged long-value frames were inspected separately at native resolution.

## Five fidelity surfaces

| Surface | Current assessment |
|---|---|
| Fonts and typography | Host system sans remains consistent. The smaller primary reading has balanced numeral shapes and spacing; units share its baseline at normal size and basis copy sits directly below. Secondary facts support the reading without competing with it. Whole 88,888 remains readable at narrow/enlarged sizes. System-ui and Arial are covered by the ink matrix; no new font or bitmap numeral is shipped. |
| Spacing and layout rhythm | Activity, reading, trace, Output/Elapsed, measurement details and Mac band form one coherent instrument. The selected layout direction is unchanged. Narrow layouts stack useful content; enlarged text can scroll vertically. Session keeps Open Scope outside its bounded scrolling content; Compact preserves its smaller presentation. |
| Colors and tokens | Restrained cyan/info accents, neutral surfaces and dividers preserve the selected direction. Current light/dark main and Session frames remain legible; semantic warning/critical tones and focus/disclosure behavior are retained by existing checks. |
| Image quality and assets | Existing vector icons and observation-generated SVG traces remain sharp. No generated bitmap is shipped as UI and no invented waveform, gauge or logo replaces product data/assets. The original concept board appears only as review evidence. |
| Copy and content | Phase, runtime/model, watch scope, unit and measurement basis are explicit. Request average, recent interval, estimate, last/completed and unavailable remain distinct. Held traces use last-reading language; pause/stale states remove current values. History, Connections, Captures and detail actions use plain labels. |

## Current responsive evidence

These are actual rendered synthetic fixtures, not design mockups. Product-only documentation crops exclude host header controls; the explicit Session-header proofs include the emulated host. Different fixture routes/data explain supporting-content differences. A tall capture viewport only exposes real lower content and does not change its layout width.

| Evidence | Scope |
|---|---|
| [Current dark instrument](docs/design/5.0/typography-synthetic-instrument-dark.png), [light instrument](docs/design/5.0/typography-synthetic-instrument-light.png) | 920×760px, 1×; mature 90-second observed trace, current request-average basis and grouped Mac facts. |
| [Current 320px main](docs/design/5.0/typography-narrow-25-6.png), [wide long value](docs/design/5.0/typography-wide-long.png) | Ordinary narrow 25.6 and wide 88,888; complete numerals, unit and basis. The short trace honestly reflects startup observation history. |
| [Current 320px/32px full main](docs/design/5.0/typography-enlarged-long-full.png) | Fully painted lower content at 200% text. Whole 88,888, unit/basis, wrapped navigation, trace, facts and stacked Mac labels/values remain readable. Vertical scroll is expected. |
| [Current dark Session](docs/design/5.0/typography-synthetic-session-dark.png), [light Session](docs/design/5.0/typography-synthetic-session-light.png) | 430×245px and 320×243px, 1×; mature observed trace and complete Open Scope footer. Host controls intentionally lie outside these product-only crops. |
| [430px Session with header](docs/design/5.0/typography-session-header-430.png), [320px Session with header](docs/design/5.0/typography-session-header-320.png) | Actual guest at the stated CSS width, plus emulated SDK host header; not the earlier fixed-280px fixture. |
| [Session 430px/24px long reading](docs/design/5.0/typography-session-long-430-24.png), [320px/32px long reading](docs/design/5.0/typography-session-long-320-32.png) | Actual whole 88,888 at approximately 57px and 76px, respectively. Unit/basis move below the number without splitting or clipping it. The footer remains visible. |
| [Current Compact](docs/design/5.0/typography-compact-final.png), [enlarged Compact long value](docs/design/5.0/typography-compact-long-large.png) | Current smaller numeral and basis at ordinary and enlarged sizes; whole 88,888 remains readable. The 200px ordinary Compact guard is retained. |

Earlier [fallback Session](docs/design/5.0/standard-session-fallback.png), [enlarged media Session](docs/design/5.0/standard-session-enlarged.png), [warning Session](docs/design/5.0/standard-session-warning.png), [offline Session](docs/design/5.0/standard-session-offline.png) and [offline main](docs/design/5.0/standard-page-offline.png) remain supporting state/structure evidence. Their typography precedes this revision; they are not presented as exact-current numeral proof. Likewise, files named `docs-final-synthetic-*`, the earlier `unclipped-*` glyph crops and [120px comparison](docs/design/5.0/historical-120px-comparison.png) are explicitly historical after the latest user feedback.

## Functional evidence and limits

The current ink result is **16/16 passed**. The complete ink matrix covers main, Session and Compact in Chromium and WebKit; 1160/16px, 320/16px, 320/32px and 430/24px as applicable, with system-ui and Arial. It checks exact 25.6, 889, 88,888 and 100K; real Canvas glyph-ink boundaries against clipping ancestors; one numeric line; absence of per-digit masks; no horizontal page overflow; and enlarged text no smaller than the same value at ordinary size. A reachable Session reading is scrolled back into view after changing root text size for the comparison; that preserves the real ink assertion rather than testing an offscreen item after a layout-induced scroll reset.

**Focused-run mapping:** `focused-tests.log` records 70 passes and four failures; all 16 current ink cases pass in that run (Chromium cases 30–37, WebKit 67–74). The four failures were only the 652px light/dark tests in both engines, whose old 100–120px expectation contradicted the user-requested smaller type. Updating that expectation to the approved 56–80px range produced 4/4 passes in `type-scale-tests.log`, with production unchanged between runs per the source owner. This closes 74 unique focused cases; it is not one contiguous 74-case successful run. The [receipt](docs/design/5.0/text-ink-regression.json) binds test/artifact and log hashes. The earlier 14/16 exploratory ink run is superseded because its ordinary/enlarged font comparison reset Session scroll; the final test restores visibility and retains every ink assertion.

The existing behavioral suites preserve readings/bases, current-versus-last expiry, pause/resume, scope changes, History/Captures, storage/capture operations, keyboard focus/Back/Escape, disclosure persistence, theme repaint, media semantics, hidden-surface polling and reduced motion. Migrations use visible navigation and detail routes, without forcing a removed Classic design. Prior targeted migration checks are historical evidence, not final totals. No functional test count here represents a complete final browser matrix.

After typography/source/QA freeze, the coordinator will bind the final exact-commit hosted full-browser result and immutable artifact hashes in the release verification index. The previously interrupted local matrix is not a passing final receipt. Renderer/service performance, real inference, installed-host header/popover/Escape behavior, native UI and release qualification are separate gates. These visual/functional checks make no performance claim.

## Comparison history

| Iteration | Outcome |
|---|---|
| A translation 1 | [First comparison](docs/design/5.0/iteration-01-comparison.jpg): supporting hierarchy/type too weak and footer too long. Blocked at that stage. |
| A translation 2 | [Revised comparison](docs/design/5.0/iteration-02-comparison.jpg): strengthened type, qualifier placement and detail routing; passed that earlier scoped review. User later requested major polish. |
| Major polish / standard default | Stronger instrument/Session grouping and Mac band approved; user required it as the only presentation. Navigation/focus/error/overflow/Compact/enlarged-collision defects were corrected. |
| Clipping report | User’s clipping screenshot invalidated provisional approval. Real ink test reproduced the masked 25.6 failure; plain text and safe whole-value sizing passed the earlier eight-case check. [Historical 120px comparison](docs/design/5.0/historical-120px-comparison.png). |
| Typography follow-up | User rejected the oversized numeral and typography after clipping was corrected. Current actual comparison and wide/narrow/Session/Compact renders show the smaller, lighter, naturally spaced treatment. Actual same-input comparison and responsive inspection found no concrete optical defect. Current ink passes 16/16 and all 74 unique focused cases close through the documented 70+4 mapping. |

## Checklist

- [x] Inspect source and current implementation together with stated density/content limits.
- [x] Review all five fidelity surfaces and the actual numeral/unit/basis relationship.
- [x] Inspect current wide/narrow/enlarged, light/dark, Session/header and Compact frames.
- [x] Retain prior state, accessibility, privacy and measurement-honesty checks.
- [x] Confirm the complete current 16-case ink result and document the 70+4 focused mapping accurately.
- [x] Keep whole-suite, exact-artifact and nonvisual release gates separate from visual acceptance.

No new aesthetic direction is requested; the selected layout remains in force.


## Actual-width Session correction after installed-host feedback

Michael rejected the installed Session panel after the preceding typography review. This focused correction supersedes the earlier Session images and header-control layout above; full-page and native designs retain their own prior evidence.

- The actual OpenChamber 2.3.3 header renders three controls in two columns and limits its selector to 5rem. Scope now clears that binding and renders its fully labeled scope, Pause and Details controls together inside the guest. The host title remains unchanged.
- At 300 and 320 logical pixels, the new body is 154.17 pixels tall with the sparse startup pressure fixture. Reading size is 28px, phase 13px, and the toolbar 26px. A priority warning is one plain line. There is no nested card or empty reserved plot.
- The measured trace is at most 28px tall and only renders for at least three samples with a connected segment. Gaps remain gaps. The sparse disconnected path is covered by a meaningful rendering regression test.
- Current dark and light Session release images use startup synthetic observations, not a matured trace chosen to conceal early gaps. Page image bytes did not change. Exact capture provenance is retained separately.
- 34 focused browser cases pass in Chromium and WebKit, including 300/320/430px, both themes, enlarged text, one-row controls, pause/resume, keyboard focus across freshness transitions, snapshot popovers, and media under the host height cap. Typecheck and the eight precision cases pass.
- Full package check passes 1,930 Bun, 71 Node and 15 Python tests. Full hosted browser CI and actual-host verification remain independent release gates and are recorded separately, not inferred from these focused checks.

Rendered Session acceptance: passed. This is code and rendered review, not a claim of renewed human approval. No collector, sampling policy, native source or performance budget changed.

## Prompt-reading ETA

The Session and Live measurement labels now include a compact, qualified **Est. … left** line. It remains visible alongside the priority warning, and snapshot Details explains that generation time is excluded. Reported engine estimates take priority; otherwise a bounded window of existing prompt-token observations supplies the estimate. No collector, timer, saved field, service, or native source changed.

- Full package verification passes 1,939 Bun, 71 Node and 15 Python tests with the original bundle ceilings.
- All 28 Session browser cases pass in Chromium and WebKit, including reported/observed ETA, 300/430px layouts, pause, stale progress, phase exit, popover explanation, and full Live.
- All 20 navigation/layout cases pass in the isolated one-worker run. A preceding mixed-engine, two-worker local run had intermittent focus delivery failures (45/48 passed); these are retained in the task logs, not counted as a full-suite pass. The original hosted WebKit heading clipping is addressed with an 8px scroll margin, without weakening its bounds assertion. Complete hosted engine jobs remain the release gate.


## ETA accessibility and first-trace focus correction

Full hosted testing identified a genuine focus defect behind the earlier intermittent navigation failures: inserting the first engine trend replaced the following disclosure subtree. Live now retains a hidden, zero-height trend host so its neighboring controls keep their DOM identity and focus when samples arrive. A browser regression verifies identity, keyboard focus, and Enter activation across that transition. Cloud views still omit the engine host.

ETA explanations are available through keyboard-accessible measurement details. The ETA label no longer relies on a pointer-only tooltip. The current focused Session, navigation, UI accessibility, and cloud suites pass all 108 cases across Chromium and WebKit. A further WebKit content-height/completion/consistency run passes all 50 cases. Hosted timing failures exposed tests publishing observations before their initial chat boundary settled; setup now waits for the actual Waiting state and advances simulated time before the new observation, and the cadence test freezes time before mounting. Measurement, expiry, and rate assertions are unchanged.

Actual OpenChamber 2.3.3 checks on the preceding ETA artifact confirmed the compact Session, passive Splash generation, snapshot Details, Escape dismissal, and Pause/Resume. The final accessibility/focus artifact still requires exact-head hosted CI, final artifact performance checks, and a storage-preserving installed refresh. A real prompt-reading phase was observed, but a live numeric ETA was not captured; ETA values are verified with synthetic reported and observed progress fixtures.
