# Standard Scope interface — design QA

final result: passed

The user approved the polished precision direction and then required it for everyone. The delivered interface has one standard presentation; there is no Classic/Next picker or onboarding choice. This is an agent visual review of browser-rendered synthetic fixtures, supported by automated functional checks. It is not a human usability study, a pixel-perfect claim, or proof of installed-host compatibility.

## Findings

No actionable P0/P1/P2 issue remains in the reviewed standard interface. The user-reported numeral clipping invalidated the provisional pass; the corrected current images and eight-case ink regression below close that defect. The direction remains the user-approved polished precision interface.

Resolved during this pass:

- **[P1] Primary numeral ink was clipped.** The prior main readout retained hidden-overflow per-digit cells despite disabled rolling. Negative tracking shaved the 5, decimal and 6 in 25.6. A real font-ink boundary regression reproduced overrun of 1.3/1.9/2.7px respectively before the fix. The standard main/Compact now render one escaped numeric text run with no digit masks; a width budget fits long values on one line without changing the displayed reading. All 8 targeted Chromium/WebKit cases pass. [Regression receipt](docs/design/5.0/text-ink-regression.json), [current Chromium 25.6](docs/design/5.0/unclipped-25-6-chromium.png), [WebKit 25.6](docs/design/5.0/unclipped-25-6-webkit.png), [Chromium long value](docs/design/5.0/unclipped-long-320-chromium.png), [WebKit long value](docs/design/5.0/unclipped-long-320-webkit.png).

- **[P1] Local navigation was blocked by service cards.** History/Captures could be visible yet unavailable during approval/version mismatch. They now open local records while Live retains the correct service card.
- **[P2] Back/Escape returned focus to hidden legacy controls.** Secondary views and Connections now restore focus to their actual visible navigation/detail origin.
- **[P2] Session action errors lost their announcement role.** Failed actions again use `role="status"`; the explanatory error remains visible and is cleared on chat switches.
- **[P2] Narrow/enlarged text overflowed.** Long model names exceeded their parent; the primary grid and enlarged navigation retained excessive intrinsic widths. Their sizing/wrapping was corrected without hiding the information or reducing text.
- **[P2] Compact inherited the mobile masthead spacing.** The 430px rail had grown to 239px. Scoped Compact rules restore 178px, below the unchanged 200px test guard.
- **[P2] Enlarged header/Mac facts could overlap.** Typography-relative rules now put the brand on its own row and stack Mac labels/values where necessary. Dedicated disjoint-rectangle regressions and the [current 320px/200% long-warning render](docs/design/5.0/standard-320-32-long-warning-unclipped.png) confirm the corrected header and Mac fact stacking.

## Comparison target and normalization

- **Source visual truth:** [selected direction board](docs/design/5.0/selected-direction-board.png), 1536×1024px; the user selected left A. The approximate panel crop is x 30/y 69/720×894px. It is a generated concept with no authoritative CSS viewport or device density.
- **Current full-view comparison:** [source A and final standard instrument together](docs/design/5.0/standard-final-comparison.png), 1920×1390px. The complete original board and the actual capture are embedded intact; CSS crops left A and uniformly scales its 720px panel to 920px. Actual [dark instrument](docs/design/5.0/docs-final-synthetic-instrument-dark.png) is 920×761px at 1×, captured from the 920-CSS-pixel product frame in a 1120px-wide browser. No implementation image is stretched. [Normalization manifest](docs/design/5.0/standard-final-normalization.json).
- **State:** generating, local oMLX, synthetic request average, an actually accumulated 90-second fixture trace, current output/elapsed and Mac values. Source and actual model, values, waveform and runtime differ. The source's invented Swap bar is omitted because Swap has no meaningful utilization denominator.
- **Accepted evolution:** the user explicitly approved the polished implementation after the original A translation. Its denser frame, quieter trace, grouped Mac band and explicit measurement qualifier govern acceptance. The source comparison checks hierarchy and visual lineage; it does not demand the earlier concept's exact heights or illustrative data.
- **Focused inspection:** header/navigation; activity/model/scope; speed/unit/basis; graph/scale/time; Output/Elapsed; Mac facts; disclosure/control icons. These regions were inspected in the combined input and native-resolution frames. The glyph fix also has focused Chromium/WebKit crops at 2× DPR: 1716×238px represents 858×119 CSS px for 25.6; 568×372px represents 284×186 CSS px for the long value. These are actual browser element screenshots, not enlarged bitmap edits. Their complete numerals, decimal/comma, unit and qualifier were inspected at original resolution.

## Required fidelity surfaces

| Surface | Review and outcome |
|---|---|
| Fonts and typography | System sans follows the host's existing font stack. Large numeric reading, stronger phase and medium-weight labels preserve A's hierarchy; unit/source are subordinate but readable. The generated source's exact family/antialiasing is unknown. Current glyph crops and the ink regression check complete text at normal/narrow/enlarged sizes in system-ui and Arial; enlarged readings cannot shrink below their ordinary-size rendering. Narrow/enlarged evidence also covers wrapping and truncation. |
| Spacing and layout rhythm | One continuous instrument replaces disconnected cards. Activity/scope, reading/basis, trace, facts, details and Mac band have clear boundaries. The approved denser composition fits useful content above the fold; narrower layouts stack real content. Compact remains bounded; Session keeps its primary action outside its internal scrolling content. |
| Colors and tokens | Restrained cyan/info tint, neutral surfaces and dividers retain the selected direction. Light/dark and custom palettes repaint without losing focus/disclosures. Existing contrast checks remain active; warning/critical tones stay semantic. |
| Image quality and assets | Existing product vector icons and observation-generated SVG graphs are sharp. No generated bitmap is shipped as UI, no fabricated waveform/gauge replaces real data, and no replacement logo or fake asset was introduced. Existing production code/assets were an explicit user constraint; the concept's illustrative trace is not a literal asset requirement. |
| Copy and content | Activity, runtime/model, scope, unit and measurement basis are explicit. Request average, recent interval, estimate, completed/last and unavailable states remain distinct. Held traces use last-reading language; paused/stale states remove current values. History, Captures, Connections and detail actions use plain labels. No design brief text appears in product UI. |

## Responsive and state evidence

Exact-current full main/Session frames, the unclipped 320px/200% render and both engines' focused glyph crops were captured after the final numeral correction. Other saved state/layout images below precede that narrow correction and are supporting structural evidence; they do not prove final numeral ink. The final whole-suite snapshot is a separate release gate.

| Evidence | Scope and interpretation |
|---|---|
| [Dark full instrument](docs/design/5.0/docs-final-synthetic-instrument-dark.png), [light](docs/design/5.0/docs-final-synthetic-instrument-light.png) | 920×761px product-only frames, 1×. Normal approved composition. |
| [Earlier narrow main](docs/design/5.0/standard-page-320-light.png) | 320×1100px, 1×. Includes a 24px synthetic fixture banner and surrounding canvas; those are not product UI. |
| [Enlarged main](docs/design/5.0/standard-page-enlarged.png), [current 320px/200% long-warning](docs/design/5.0/standard-320-32-long-warning-unclipped.png), [focused masthead](docs/design/5.0/standard-masthead-320-large.png) | 430×1281px supporting render; final 320×3254px full natural product capture at 32px root text, 1×. The tall fixture viewport captures all content without clipping. Header, wrapped nav, long model, Mac facts and media remain readable; vertical scroll is expected at 200%. |
| [Dark Session](docs/design/5.0/docs-final-synthetic-session-dark.png), [light Session](docs/design/5.0/docs-final-synthetic-session-light.png) | 430×253px and 320×253px product-only frames, 1×. Host Watch/Pause/Details controls live outside the iframe and are intentionally outside these crops. |
| [Fallback Session](docs/design/5.0/standard-session-fallback.png) | 320×302px. Shows in-frame Watch/Pause/Details when host features are absent. |
| [Enlarged Session with media](docs/design/5.0/standard-session-enlarged.png) | 320×320px. The content region can scroll; Open Scope remains outside that scroll region. A visible media heading does not imply all media details fit at once. |
| [Warning Session](docs/design/5.0/standard-session-warning.png), [offline Session](docs/design/5.0/standard-session-offline.png), [offline main](docs/design/5.0/standard-page-offline.png) | 280×226px, 320×122px, 430×690px. One priority warning; absent measurement has explanatory copy and no invented value. |
| [Compact](docs/design/5.0/standard-compact.png) | 430×178px, 1×. Earlier pre-ink-fix layout proof:178px. The final renderer regression separately requires no digit masks/roll attributes in Compact. This image is not evidence of final numeral ink. |

## Interaction and verification evidence

The general browser checks exercise the standard default without forcing the removed design choice. They retain precise reading values/bases, provider/privacy behavior, current-versus-last expiry, pause/resume, scope changes, local History/Captures, storage/capture operations, keyboard focus/Back/Escape, disclosure persistence, theme repaint, media semantics, hidden-surface polling and reduced motion. Console/page errors are checked by the existing suites where instrumented.

Test migration uses visible standard navigation and detail routes. Stable hidden Session slots are checked for zero displayed height and no visible measurement; tests no longer require their DOM nodes to be destroyed. Session reports `ceil(natural height)` to the integer host API. Display-contents readouts are checked through their actual participating children. Exact numeric values, explicit basis, no-overflow checks, target-size/contrast checks, the 200px Compact guard and 320px Session cap remain in place.

Targeted verification during this migration: the earlier exhaustive Chromium blank-space matrix passed 11/11; corrected UI/core-layout Chromium checks passed 34/34; both WebKit 320px/32px light/dark heading cases passed 2/2 with bounded polling for completed scrollIntoView, retaining actual heading/control viewport bounds. After the final numeral correction, the new ink regression passed 8/8 across Chromium/WebKit,1160/16px and 320/16px/32px system-ui plus 430/24px Arial. It verifies 25.6,889,88,888 and 100K, complete font ink versus real clipping ancestors, one numeric line, no horizontal overflow and enlarged type no smaller than the same value at ordinary size. These are targeted/earlier migration receipts, not final aggregate totals. The coordinator will run the final immutable whole-browser matrix and bind final counts/hashes in the release verification index. No performance claim follows from these functional checks.

Residual scope limits: screenshots use synthetic telemetry and an emulated host; they do not establish actual inference accuracy or installed-host header/popover/Escape behavior. Native UI, packaging, public release and performance are separate gates. Browser-rendered evidence and automated/agent interaction review are not a human usability study.

## Comparison history

| Iteration | Finding, correction and evidence |
|---|---|
| Original A translation 1 | [First comparison](docs/design/5.0/iteration-01-comparison.jpg): supporting type/hierarchy too weak; extra footer extended composition. Blocked then. |
| Original A translation 2 | [Revised comparison](docs/design/5.0/iteration-02-comparison.jpg): type strengthened, qualifier moved beside reading and deeper routes grouped. Passed that earlier scoped review; the user later requested major polish. This is historical evidence, not the current single-design verdict. |
| Major polish | User approved the stronger instrument/Session grouping and Mac band, then required it as the sole interface. [Current combined comparison](docs/design/5.0/standard-final-comparison.png) shows that approved evolution. |
| Standard-default regression pass | Local navigation, focus origins, error announcement, intrinsic-width overflow, Compact spacing and enlarged collisions were found and corrected. Fixture/layout checks and the full enlarged proof cover closure. |
| User clipping report / corrected final pass | Provisional approval was withdrawn when the user identified numeral clipping. The font-ink regression failed on the old 25.6 cells and passed 8/8 after plain-text rendering and long-value fit. Refreshed [combined source/current comparison](docs/design/5.0/standard-final-comparison.png), current full frames, 320px/200% render and both engines' focused crops were opened after the fix. No actionable visual defect remains. |

## Implementation checklist

- [x] Compare source and actual together with stated density/content limits.
- [x] Review all five fidelity surfaces and focused product regions.
- [x] Inspect normal/narrow/enlarged, light/dark, Session/fallback/media, warning/offline and Compact states.
- [x] Preserve semantic, accessibility, privacy and current-versus-last behavior checks.
- [x] Close final enlarged visual proof, real glyph-ink regression, long-value fit and targeted migrated-layout checks.
- [x] Keep final whole-suite receipts, artifact hashes and nonvisual release gates in the separate release verification index; this visual verdict does not claim those gates are complete.

No P3 aesthetic change is requested; the user-approved direction is settled.
