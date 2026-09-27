# Agent Note: Bounded diff context and explicit terminal state

Status: implemented

English | [中文](2026-09-22-bounded-diff-and-terminal-state.zh.md)

## Problem

File-mutation presenters carry old and new text fragments that include unchanged context. Coloring every old line as removed and every new line as added misstates small edits and inflates their counts. Terminal cards also need to distinguish a running command with received output from a settled command whose exit code is unknown; hiding received output or treating an unknown code as zero obscures the execution state.

## Decision

`DiffBlock` uses `diff.structuredPatch` with three context lines and a maximum edit length of 256, matching the upstream Web implementation. Completed comparisons render shared context once and count only additions and removals. When the edit budget is exceeded, the complete input fragments render as a replacement. Collapse affects visible rows, while the footer and clipboard retain the complete comparison result. Input fields and the line-terminator rule remain unchanged. Collapsed tool rows obtain `+A -R` through the exported `diffTotals`, which shares the same bounded hunk comparison as the expanded footer.

`TerminalBlock` renders any supplied output while a command is running and retains its running indicator. An empty running command has no output placeholder; copying is available after settlement. An explicit `exitCode: null` renders the localized no-exit-code status and cannot indicate success. A terminating signal takes precedence. An omitted code retains its existing presentation.

The shared shell presentation parser preserves the existing `[exit code: null]` marker as `null` through both Bash and PowerShell `renderResult` → `presentResult` paths. Invalid numeric markers remain literal output. Model-visible text and persisted marker syntax do not change; typed terminal views carry the unknown-code fact to the UI.

The [diff card note](../feature/2026-07-30-web-diff-card.md) continues to own render-site selection, inline geometry, and path grouping. The [terminal card note](../feature/2026-07-28-web-terminal-card.md) continues to own ANSI rendering, geometry, and clipboard behavior. Both records remain active because these decisions are independent of line comparison and execution status.

## Alternatives considered

**Always color complete old and new fragments.** This avoids comparison work but represents shared context as edits, including identical content. The bounded comparison preserves exact counts for ordinary edits without unbounded edit-distance search.

**Use an unbounded comparison.** Exact counts for every replacement would expose synchronous browser rendering to expensive edit searches. The replacement fallback preserves every input line when the fixed budget is exhausted, at the cost of approximate counts for that case.

**Treat an unknown exit code as successful.** A completed process with no code provides no evidence for code zero. Preserving `null` through the production renderers keeps the UI from manufacturing a successful exit.

## Consequences

The browser artifact gains the `diff` runtime dependency. Within the edit budget, shared lines do not inflate totals; beyond it, totals describe the displayed replacement rather than an exact edit distance. Running-output presentation consumes only the primitive’s supplied props and does not add streaming data to tool snapshots.

Conversation previews use eight rows for narrow panes and phone layouts. The upstream Web preview uses nine; both views compute totals from the complete comparison. The browser golden preserves the local preview height without changing the comparison or hiding any row after expansion.

## Testing

Primitive tests cover unchanged text, three-line context, separated hunks, both sides of the edit budget, collapsed copying, running-output updates, and unknown-code status. Tool-card tests preserve typed `null` without casts. Shell parser tests reject invalid markers, and both shell tools exercise the actual renderer-to-presenter roundtrip with unknown exit codes.

The built-browser [diff scenario](../../../../apps/web/tests/diff-context.e2e.ts) sends the recorded prompt through the real composer and executes the real file tools. Its external byte checks cover the edited file and an untouched sibling; persisted result metadata, collapsed counts, exact context, and the fully expanded 130-added/130-removed replacement are independent assertions. It compares the captured ARIA golden only after those assertions pass. The exact case borrows the ACP owner’s live recording; the bounded case preserves the upstream authored model script. Each run owns the scaffold’s private temporary workspace and waits for complete teardown.
