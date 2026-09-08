# Agent Note: Cordis multi-session Workspace workbench

Status: implemented

English | [中文](2026-09-08-cordis-multi-session-workbench.zh.md)

## Problem

The Web client exposes one current Session even though the runtime already receives and stores independent Workspace conversations. Users who work across directories must repeatedly replace the current surface to inspect or prompt another Session.

## Decision

The browser supplies a `conversationViewport` capability that keeps a bounded set of up to four root Session ids and exposes single-session or workbench presentation modes. The capability is a Cordis service with an observable snapshot and explicit add, focus, replace, remove, reorder, mode, and ratio operations; it owns only browser view state and never writes Session events or Host data.

The existing `conversation` slot remains the sole render authority. It declares an explicit `conversation.pane` child plus workbench toolbar, empty-state, and pane-header children. Each pane is rendered through the renderer's explicit SessionProvider binding, so the existing conversation slots and session-scoped stores are reused without importing presentation implementations across plugins.

`SessionRuntime` retains the current Session stage and an additional staged set. Staged Sessions open their bounded history windows and receive the existing stream updates; removing a pane releases its browser window but never cancels its Session. A masked current selection remains staged until the selection moves or the user clears it.

The independent `@deepseek-ai/dsh-client-ui-workbench` package contributes only its Cordis service consumer and slot entries. The conversation root declares the viewport store and shares its framework-owned instance with the provider through `slots.bindStore()`. That store contains Session ids, mode, active id, and ratios under `dsh.conversation.workbench.v1`; rehydration reconciles ids with the current Session list before staging them.

The Gateway exposes an account catalog containing personal roots and project roots allowed by the authenticated member ACL. Selecting a project row starts a lazy target-aware `ConnectionHandle` and a `SessionRuntime` in the runtime pool; the pool aggregates list and provide lookups while each runtime retains its own event stream, history windows, and scope resources. The target selector is validated against current membership before the Gateway issues the runtime principal, so a browser cannot turn a session id from the catalog into access to another project.

Personal metadata is read through the authenticated personal runtime's existing `session.list`, because those histories may remain in JSONL. Agent-addressed Typert Remote calls resolve the same session target before dispatch, so commands, permission changes, and other scoped capabilities follow the pane's runtime too.

## Alternatives considered

**Duplicate ConversationRoot or ChatView implementations in the workbench package.** This would bypass slot ownership and split the existing per-session feature assembly. The workbench instead renders the existing `conversation.pane` authorization through explicit SessionProvider instances.

**Create one Gateway connection per Workspace or aggregate account project scopes.** The account catalog is metadata-only and ACL-filtered. A pane starts one target-aware connection for its selected project runtime, preserving that runtime's principal, sandbox, approval, and event stream instead of merging foreign Sessions into the current runtime.

**Keep only the current Session staged and reload each pane on focus.** That loses live updates and repeats the slow history open the workbench is meant to remove. The staged set keeps four bounded windows while preserving the existing per-Session retention limit.

**Store pane state in a module singleton or window global.** This would outlive Cordis plugin fibers and violate reload isolation. The root registration owns a framework-managed store instance with the repository's bounded local persistence behavior.

The chooser treats account-catalog exclusions as authoritative. It combines personal `session.list` with the sidebar's `workspace.list.archivedSessionIds`, excludes indexed project archives, hides inactive blank drafts, and rechecks the target archive set before opening a Session.

## Consequences

Four conversations can stream and accept independent input in one browser surface, while each action still resolves through its Session identity, selected runtime, and the existing permission path. The current single-session view remains available. The Gateway adds an account catalog route and validated target selector; Host API semantics, Session JSONL, database schema, and Collaboration authorization rules remain unchanged.

The renderer and conversation contracts are wider: explicit SessionProvider resolution and a pane child are now framework responsibilities. The [scope/provide decision](2026-07-25-web-client-session-scope-and-provide-channel.md) continues to own Session identity and provider-roster publication; the [bounded-window decision](../bug-fix/2026-09-03-bounded-live-window-and-incremental-reconnect.md) continues to own per-Session retention. Four active history windows consume more browser memory than one, so the feature keeps the existing tail-page and live-retention bounds and limits the pane count instead of adding unbounded virtualization.
