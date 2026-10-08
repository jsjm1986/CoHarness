# Agent Note: Workbench file previews render Markdown and HTML on the shared workspace resource owner

Status: implemented

English | [中文](2026-09-25-workbench-html-markdown-previews.zh.md)

## Problem

Upstream alpha.2 registers HTML and Markdown document bodies in `ui-sidebar-documentpreview`. The local workbench file tab sent only PDF and Office files to a document body and showed every other file through the plain-text path, so `.md` and `.html` previews lost upstream's rendered output. The port had to add both bodies without standing up a second resource owner: every read still goes through the Session-scoped, runtime-targeted `WorkspaceResourceOpenRequest` and the `WorkspaceResourceRegistry` lifecycle.

## Decision

**`WorkspaceFileTab` routes by extension to one of five bodies, all fed by the same authorized readers; the spreadsheet body is covered by the [sibling preview note](2026-10-01-workbench-spreadsheet-preview.md).**

- `md`/`markdown` mount `WorkspaceMarkdownPreview`, which accumulates the existing version-guarded `readPreview` text pages until `eof` and renders the prefix through `MarkdownText` without wrapping. Pages keep arriving under the tab's abort signal; a stale-version response or an access failure stops accumulation, and access denial disconnects the resource.
- `html`/`htm` mount `WorkspaceHtmlPreview`, which reads the complete source through `readFileBytes` in [`preview-readers.ts`](../../../../packages/client/ui-workbench/src/client/preview-readers.ts) — `stat` plus `workspaceFiles.readBytes` windows pinned to the first observed version, bounded by the caller's complete-file limit and returned as Base64 — then `workspaceFileBytes` decodes it for packaging of directly declared relative `.js` classic scripts and `.css` stylesheets. Each dependency is resolved client-side against the document's directory (`.`, `..`, query, and fragment folded before the call, because the Host rejects `..` verbatim) and read through the same `readFileBytes` path with the same Session, runtime target, and signal. Packaging enforces 4 MiB per asset, 32 MiB total, and 64 distinct assets; external, root-relative, scheme, backslash, and NUL references are never read, and module imports, CSS `url()`/`@import`, and runtime `fetch` stay unsupported. The packaged document runs in an opaque Blob iframe with exactly `sandbox="allow-scripts"`; replacing or unmounting the preview revokes the outer Blob URL, and invalid UTF-8, read failures, or exceeded limits fail the preview instead of publishing a partial package.
- `pdf`, `doc`, `docx`, `ppt`, and `pptx` keep `WorkspaceDocumentPreview`; `xlsx`, `xls`, `csv`, and `tsv` route to the workbook viewer; everything else keeps `WorkspaceFilePreview` (paged text, `data:` image, or bounded Base64).
- Preview content stays component-local transient state: the registry still owns only metadata, subscriptions, and change notices; the body owns reads, packaging, and cancellation through the request's abort signal. Late results cannot publish because every await checks the signal before committing state.
- The metadata subscription is framework-owned: `WorkspaceFileTab` binds the source through `keyedHooks.workspaceResource` (an empty key for a hidden tab) and hands every preview the plain `WorkspacePreviewResource` face — `{status, value, error, accessDenied}` plus bound `reload`/`revoke` callbacks — so no preview holds the registry or a raw source.
- Shared copy comes from the workbench locale; each new body owns its localized loading, failure, retry, and frame-title labels.

## Alternatives considered

**Port the upstream `documentPreviews` registry plus a keyed document slot.** Rejected: the workbench file tab already owns routing, header controls, reload, and access-denial handling through `WorkspaceResourceRegistry`. A second registration surface would duplicate the owner without a consumer that needs pluggable renderers; extension routing keeps one dispatch site.

**A Host `readRelated` RPC for HTML dependencies.** Upstream resolves related paths Host-side. The existing file API already enforces Session workspace authorization on `stat`/`readBytes`, so resolving the relative reference client-side and reading through the same authorized calls composes the same guarantee without a new wire surface or a second path parser.

**A content cache beside the registry.** Rejected by [the document-preview operations note](../architecture/2026-09-08-document-preview-operations.md): a second owner duplicates addressing, cancellation, and subscription lifetime that the request's abort signal already provides.

## Testing

The [HTML preview component suite](../../../../packages/client/ui-workbench/tests/workspace-html.client.spec.tsx) holds packaging promises across unmount and renderer replacement. Completion after unmount cannot create a Blob URL; rejection from a canceled renderer cannot replace the active iframe with a failure state. Removing either cancellation check fails its focused regression. The deferred packaging fixtures settle their promises before restoring the global Blob URL hooks.

## Consequences

Markdown and HTML previews now behave like upstream's on the surfaces that matter — incremental text for Markdown, a fully packaged opaque iframe for HTML — while ACL, versioning, cancellation, and runtime targeting stay exactly those of the existing file tab. HTML dependency graphs pay bounded whole-file memory; unsupported traversals are documented in the package README rather than silently half-loaded. The [recorded browser scenario](../../../../apps/web/tests/workspace-files.e2e.ts) exercises Markdown rendering, the sandboxed packaged frame, and the shared change/reload path.
