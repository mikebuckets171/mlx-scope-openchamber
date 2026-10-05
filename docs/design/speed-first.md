# Scope: speed first

The daily glance answers “How fast is the reply?” OpenChamber’s Work Status section and the native menu popover are the priority surfaces. Keep the host font, native controls, semantic colors, and light/dark theme behavior.

## Hierarchy

1. Activity and model, with explicit measurement scope.
2. Speed with its unit and measurement basis, or the current phase when no speed is available.
3. First-token time and context, only when the source supports the stated meaning.
4. A short real-data chart. Omit an empty chart; preserve observation gaps.
5. Secondary request details and a compact machine summary. Warnings remain visible.

Use “First token” in the compact performance views. “Last reply” (extension) and “Last response” (native) distinguish completed measurements from the active request. Keep their age visible. “Context used,” “Context remaining,” and “Context window” are distinct measurements; capacity alone never implies usage. Preserve server-wide, inferred, derived, observed, last observed, and estimated qualifiers.

## Navigation

Extension: Live and History at every width. Live opens Server & Mac details; History opens Captures. Each secondary view has an explicit Back action. Capture tools offer Reply or Timed window; changing views never silently ends an active capture. Work Status retains its saved glance/expanded preference and remains within 200 px.

Native: Live and Mac. The menu popover leads to Open Monitor. Runtime details and More readings contain advanced information; Settings separates Connection and General. Existing connection, credential, update, sharing, storage, and monitoring behavior is preserved.

## Visual language

Use spacing and restrained separators instead of nested cards. Keep one dominant number, compact supporting text, and no decorative motion. Disclosures have descriptive names, visible focus, and stable state through updates. Long model names truncate with the full value available; qualifiers and alerts remain readable.

OpenChamber colors remain semantic host tokens: foreground, muted text, background, border, accent, warning, and error. Native colors remain macOS semantic colors. There is no fixed cross-product palette or new shared UI dependency.

## Acceptance

Review widget 280 px, rail 320/430 px, page 1160 px, popover 345 px, and native window minimum/default sizes. Verify keyboard navigation, warning visibility, disclosure state, live versus completed timing, absent capabilities, and capture continuity. Synthetic fixtures validate layout and state handling; they are labelled and are not live-runtime validation.
