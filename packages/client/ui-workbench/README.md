# @deepseek-ai/dsh-client-ui-workbench

English | [中文](README.zh.md)

The Cordis browser plugin that presents up to four existing Workspace Sessions as one multi-pane conversation workbench. It owns the Workspace/session chooser and controls for pane selection, ordering, ratios, and mode switching; it consumes the `conversationViewport` capability and contributes toolbar, empty-state, and pane-header entries through ui-conversation's declared slots.

The plugin never imports ConversationRoot, ChatView, InputBar, or another presentation implementation. The conversation slot owner renders each pane through an explicit SessionProvider, so every pane receives the ordinary Session standard kit, session-scoped stores, projections, and injected actions from the same object layer. Root-slot injected controls resolve the active pane at render time; a cached root injection never owns a fixed Session or runtime target.

## Composition

`apply()` waits for `conversationViewport` and registers the workbench controls through `ctx.slots.inject()`. The provider owns a bounded Session stage set; removing this plugin releases additional history windows and leaves the ordinary current-session view available. The Gateway supplies an ACL-filtered account catalog, while each selected project runtime receives its own target-aware transport and principal assertion. In cloud Web, `workspace/resource-open` asks a preview consumer to accept an explicitly targeted file. The toolbar browses direct Workspace directories, uses shared resource metadata and version-guarded `workspaceFiles.read` pages, and falls back to bounded Base64 windows for binary files. Changed files require reload, transient reconnects retain content, and access denial hides it. Local loopback uses `host.openPath` only when the owning connection advertises native opening. No Session JSONL, persistence format, or Collaboration authorization semantics change.

## View state

The provider stores only the mode, Session ids, active id, and pane ratios under the browser-local `dsh.conversation.workbench.v1` key. Rehydrated ids are reconciled against the current account catalog and target runtime visibility before they are staged or rendered. A duplicate id focuses its existing pane; a fifth id is refused without replacing an existing pane.

Desktop uses equal or ratio-adjusted columns, with two rows when four columns cannot fit. Every desktop pane keeps a 360px minimum width. Separators support pointer, touch, and arrow-key resizing; each pane can be maximized or moved through its menu. The toolbar lets users select an existing conversation or create one in an explicitly chosen Workspace, reports failures, and requires an explicit replacement when the pane limit is reached. Users can return to the existing single-session mode. Narrow viewports render one active pane at a time while the other staged Session objects continue receiving their normal runtime updates. Closing a pane removes it from the workbench and never stops its Session.

The conversation chooser excludes archived roots and inactive blank drafts. Personal rows use the same `workspace.list.archivedSessionIds` snapshot as the sidebar; project rows exclude archive-index entries, and opening a target rechecks its live Workspace archive set. An account catalog response is authoritative and is never supplemented with excluded local rows.

## Model Experience

None, as this plugin arranges existing conversation views and contributes no prompt, tool schema, or Session event.

#### KV Cache effect

None; the plugin does not assemble or send a model request.

## Known Limitations and Deferred Work

- The workbench is limited to four root Sessions and does not yet expose nested split trees or cross-session context sharing.
- The catalog is metadata-only and loads conversation history lazily when a pane is selected; it does not preload every project runtime.
- The browser-local view state is not synchronized between devices or browser profiles.
- The preview currently opens one text resource at a time; binary files and files rejected by the text policy are shown through a bounded Base64 byte window and do not provide an editor or upload path.
