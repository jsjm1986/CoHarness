# @deepseek-ai/dsh-client-ui-workbench

English | [中文](README.zh.md)

The Cordis browser plugin that presents up to four existing Workspace Sessions as one multi-pane conversation workbench. It owns the Workspace/session chooser and controls for pane selection, ordering, ratios, and mode switching; it consumes the `conversationViewport` capability and contributes toolbar, empty-state, and pane-header entries through ui-conversation's declared slots, plus a sidebar panel through ui-workspace's `sidebar.workspaces.workbench` hole.

The plugin never imports ConversationRoot, ChatView, InputBar, or another presentation implementation. The conversation slot owner renders each pane through an explicit SessionProvider, so every pane receives the ordinary Session standard kit, session-scoped stores, projections, and injected actions from the same object layer. Root-slot injected controls resolve the active pane at render time; a cached root injection never owns a fixed Session or runtime target. The layout menu’s open state belongs to the transient root chooser store, so movement between the Hero and Session header retains the user’s opening gesture; selection and explicit dismissal close it.

## Summary

Use `dsh-client-ui-workbench` to present up to four existing Workspace sessions as one multi-pane conversation workbench, with a session chooser plus pane selection, ordering, ratio, and mode controls. Each pane renders through the ordinary conversation slot owner under an explicit session scope, so injected controls always resolve the active pane rather than a cached target.


Cross-runtime loading and creation share the current navigation intent. Selecting another pane, switching presentation or named layouts, or unloading the plugin prevents older responses from replacing the active pane. A completed Host creation remains in the catalog even when its navigation was superseded.

## Composition

`apply()` waits for `conversationViewport` and registers the workbench controls through `ctx.slots.inject()`. The sidebar panel lists the staged panes with focus and close actions, offers Add and equalize-ratios actions bound to the same chooser store and viewport capability, exits back to single-session mode, and declares the `conversation.workbench.display` hole that ui-conversation fills with a compact display-preferences row. The provider owns a bounded Session stage set; removing this plugin releases additional history windows and leaves the ordinary current-session view available. The Gateway supplies an ACL-filtered account catalog, while each selected project runtime receives its own target-aware transport and principal assertion. In cloud Web, `workspace/resource-open` asks a preview consumer to accept an explicitly targeted file. The toolbar browses direct Workspace directories and opens files in the shared right sidebar, bound to the initiating Session and runtime. The tab uses shared resource metadata and version-guarded `workspaceFiles.read` pages, with bounded Base64 windows for binary files. Hidden tabs release content readers while the sidebar retains resource metadata; closing a tab releases its occurrence. Changed files require reload, transient reconnects retain content, and access denial hides it. Local loopback uses `host.openPath` only when the owning connection advertises native opening. No Session JSONL, persistence format, or Collaboration authorization semantics change.

Markdown file links open the existing authorized file tab at the requested first line. Reopening another line of the same file updates navigation without creating a second resource. Link destinations do not change filesystem permissions.

The file tab picks a preview body by extension. Markdown files (`md`, `markdown`) accumulate the same version-guarded text pages and render through `MarkdownText` without wrapping. HTML files (`html`, `htm`) read the complete source through version-guarded `workspaceFiles.readBytes` windows, then package directly declared relative `.js` classic scripts, `.css` stylesheets, and recognized image files read through the same authorized Session and runtime target. Dependency reads resolve inside the Session workspace with a fixed 4 MiB per-asset, 32 MiB total, and 64-asset bound; external, root-relative, module, and CSS-traversed references are never read. The packaged document runs in an opaque Blob iframe with exactly `sandbox="allow-scripts"`; replacing or unmounting the preview revokes the Blob URL. Invalid UTF-8, read failures, or exceeded limits fail the preview instead of publishing a partial package. PDF and Office files keep their document bodies; other files keep text or the bounded Base64 window.

Office files request authorized conversion through the same file tab. PDF.js renders visible pages in an owned Worker, with selectable text and missing-font notices. Hidden bodies release content and workers while the tab retains its page preference. Source changes require reload; revocation clears content immediately. Ordinary PDF reads retain the Workspace byte-window limit; converter limits govern Office inputs and outputs. See [document conversion](../../../docs/subsystems/office-to-pdf.md) for engine and adaptation rules.

## View state

Account-scoped version 2 records keep their explicit encoding version and remain outside the visible pane set until the complete catalog proves one runtime for each raw ID, including IDs whose text resembles a newer browser key. Ambiguous or inaccessible entries are removed from the restored selection; named layouts and valid panes remain. Restoration reads the owner’s current record when the catalog settles and acquires each runtime through pane adoption before choosing the saved active pane.

The conversation viewport stores mode, named layouts, Session ids, active panes, and manual ratios in one versioned `dsh.conversation.workbenches.v3.<principal>` record. The principal comes from verified Gateway identity or an explicit independent-Host declaration. Identity loss clears in-memory layouts and releases staged panes; another account cannot restore their names or selections. Session visibility is rechecked before staging. Legacy unscoped records can migrate only for the independent local operator after catalog validation; Gateway does not infer their owner. The same original Host ID can occupy separate panes in different runtimes. An identical runtime-qualified key focuses its existing pane; a fifth id is refused without replacing an existing pane.

Desktop uses equal or ratio-adjusted columns, with two rows when four columns cannot fit. Every desktop pane keeps a 360px minimum width. Separators support pointer, touch, and arrow-key resizing; each pane can be maximized or moved through its menu. The toolbar lets users select an existing conversation or create one in an explicitly chosen Workspace, reports failures, and requires an explicit replacement when the pane limit is reached. Users can return to the existing single-session mode. Narrow viewports render one active pane at a time while the other staged Session objects continue receiving their normal runtime updates. Closing a pane removes it from the workbench and never stops its Session.

The conversation chooser excludes archived roots and inactive blank drafts. Personal rows use the same `workspace.list.archivedSessionIds` snapshot as the sidebar; project rows exclude archive-index entries, and opening a target rechecks its live Workspace archive set. An account catalog response is authoritative and is never supplemented with excluded local rows.

The catalog’s `personalComplete` flag distinguishes a verified personal directory from a temporarily unavailable one. Incomplete personal results preserve saved personal metadata without requesting the missing runtime; project membership rows remain authoritative. Legacy raw-ID migration waits for completeness across all possible owners. Layout edits and conversation creation from that layout remain disabled with an explanation and an explicit directory retry; ordinary single-conversation use and Workspace startup remain available. A failed account catalog never proves absence; only an explicitly independent Host may restore from its local directory.

An authorized catalog entry remains in the saved layout when its runtime is manually stopped or temporarily unreachable. An unloaded pane shows that state without conversation content; background restoration never requests an explicit start. The existing workspace start action and catalog refresh can restore it. Explicit authorization denial or a confirmed missing Session removes the pane, and account changes clear the active view.

## Invariants

**Runtime invariant:** No companion is published. Pane selection, order, and ratios are component state over the `conversationViewport` capability; sessions remain owned by the runtime.

## Model Experience

None, as browser-only pane controls register nothing model-facing; the existing conversation submission path owns all model-visible content.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- The workbench is limited to four root Sessions and does not yet expose nested split trees or cross-session context sharing.
- The catalog is metadata-only and loads conversation history lazily when a pane is selected; it does not preload every project runtime.
- The browser-local view state is not synchronized between devices or browser profiles.
- File tabs provide bounded text, Markdown, HTML, and image previews, with a Base64 fallback for other binary files. HTML packaging covers only directly declared relative classic scripts, stylesheets, and image `src` references; `srcset`, module imports, CSS `url()`/`@import`, and runtime `fetch` do not read Workspace files. An editor and uploads through the tab are not implemented.
