# Agent Note: Workbench spreadsheet preview

Status: implemented

English | [中文](2026-10-01-workbench-spreadsheet-preview.zh.md)

## Problem

Opening a spreadsheet in a workspace file tab previously fell through to the generic document path, which asked the runtime to convert the workbook to PDF. Spreadsheet-to-PDF conversion loses the grid: cell structure, frozen panes, hidden rows, and sheet navigation collapse into fixed pages, and large workbooks produce unreadable output. The upstream release-candidate tree ships a browser spreadsheet preview built on FortuneSheet, with an ExcelJS/SheetJS parser hardened for namespace aliases, UTF-16 parts, OPC traversal, and formula-result preservation.

## Decision

`xlsx`, `xls`, `csv`, and `tsv` open in a read-only workbook viewer inside `dsh-client-ui-workbench`; `doc`, `docx`, `ppt`, `pptx`, and PDF keep the existing conversion and PDF.js paths. The upstream Excel code is ported into `packages/client/ui-workbench/src/client/excel/` rather than copied as its own plugin package: the tab routes by extension in [`WorkspaceFileTab.tsx`](../../../../packages/client/ui-workbench/src/client/components/WorkspaceFileTab.tsx), reads complete authorized Base64 through `readFileBytes` in [`preview-readers.ts`](../../../../packages/client/ui-workbench/src/client/preview-readers.ts) — version-guarded `workspaceFiles.readBytes` windows bounded by the caller's `excelMaxBytes` — decodes it inside the preview, and parses in a disposable Worker under the `excelMaxBytes`, `excelMaxCells`, and `excelTimeoutMs` `Config` fields. The parser preserves formulas with cached results and reports unsupported features (charts, images, shapes, conditional formatting) instead of dropping them silently. The renderer is split into two lazy chunks — a small `LazyExcelBody` bridge in the eager-adjacent position and the FortuneSheet/parser payload — so the ~7 MB spreadsheet code never enters `lib/client.js`; no lazy chunk may synchronously require another. Repository patches carry the FortuneSheet read-only panning fixes and the ExcelJS XML canonicalization the upstream parser depends on, and the emitted chunk embeds the spreadsheet dependency license banner.

## Alternatives considered

- **Keep Office conversion for spreadsheets.** Zero new dependencies, but grid fidelity is unrecoverable from PDF and the conversion round-trip delays every open.
- **Copy the upstream package as a separate plugin.** The upstream `ui-sidebar-documentpreview` package duplicates this package's resource registry, read lifecycle, and locale plumbing; folding the feature into `ui-workbench` keeps one file-tab owner and avoids a second preview authority for the same sidebar.
- **Bundle the viewer into the main client.** Simpler chunk graph, but every session would download ~7 MB of FortuneSheet/ExcelJS/SheetJS it may never open; the two-level lazy split keeps the eager cost at the bridge size.

## Consequences

The first spreadsheet open downloads the parser/viewer chunk and parses inside a Worker with a hard timeout; a complete-file read exceeding `excelMaxBytes` fails before Worker allocation; the parser enforces the cell-area bound before dense grid materialization. Preview is read-only: editing, recalculation, and the toolbar are disabled, and unsupported workbook features surface as a notice plus an open-locally suggestion. Metadata subscription is framework-owned: the tab binds the registry's `getSnapshot`/`subscribe` source through `keyedHooks.workspaceResource`, and previews consume the plain `WorkspacePreviewResource` face (JSON metadata plus bound `reload`/`revoke` callbacks), so a complete-file read exceeding `excelMaxBytes` surfaces the configured `tooLarge` copy. Formula display relies on cached results, so files saved without calculated values show a missing-result warning. The license-bundle tests keep the spreadsheet payload out of the main client chunk behind its own lazy bridge.

## Testing

[`packages/client/ui-workbench/tests/`](../../../../packages/client/ui-workbench/tests/) covers the parser matrix (`excel-convert`, `excel-opc-fixture`, `excel-xml-fixture`, `excel-opening-fixture`, `excel-drawing-fixture`), the body and workspace lifecycle (`excel-body`, `workspace-excel`), routing (`workspace-file-tab`), and the emitted chunk/license shape (`excel-license-bundle`, `pdf-license-bundle`).

## Related

- Upstream reference: `packages/client/ui-sidebar-documentpreview` in the `dsh-v0.2.0-rc.1` worktree.
- HTML/Markdown sibling decision: [workbench HTML and Markdown previews](2026-09-25-workbench-html-markdown-previews.md).
