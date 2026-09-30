# Agent Note: Authorize historical workspace review on the owning runtime

Status: implemented

English | [中文](2026-09-23-authorized-workspace-review.zh.md)

## Problem

A turn's comparison and the current workspace file answer different questions. Reconstructing a comparison from current files loses subsequent edits and deletions. Fetching a relative URL from the Web shell also loses the personal or project runtime that owns the Session.

## Decision

The upstream [workspace recorder](../../../../packages/deliverables/workspace-changes/README.md) owns turn snapshots and announces them with `workspace/changes`. The [present tool](../../../../packages/deliverables/tool-present/README.md) separately logs explicit deliveries. The Web consumer uses their durable coordinates rather than interpreting assistant prose as file metadata.

Historical summary and diff reads use ApiProxy’s authenticated carrier. Authorization precedes lookup, checks the Session workspace and each recorded path, and repeats after asynchronous reads. Revocation, cancellation and provider replacement prevent late bytes from reaching the caller. Releasing a Host Session does not expire immutable artifacts. Storage paths and Git identifiers stay on the server; deleted files remain reviewable without reading current content.

The recorder requires paired filesystem and subprocess providers. Git snapshots execute on the workspace target; bounded, version-checked FS windows capture file-tool edits. Before publication, the Host stores a complete content-addressed review with its Session identity and aligned per-file comparisons. The Session event references this artifact, so cold reads survive Host restart. Disposal removes remote and local scratch data without deleting history; an unreachable target still reports scratch-cleanup failure.

Workspace registration uses the same runtime filesystem for canonical paths, historical header grouping, attachment, and live status. A missing remote directory or connection failure cannot fall back to a same-named Host directory. The registry waits for that provider before initializing storage, and a directory redirected to another target is not reported as the registered workspace. A registry's storage remains scoped to one fixed execution target; connection ownership and sharing require separate Gateway authorization.

One retained Session owns its client readers on its exact runtime connection. Connection replacement discards cached summaries and comparisons; Session disposal aborts reads and drops the readers. The right sidebar validates the resource's declared Session before opening or restoring it. Hidden review tabs do not initiate file comparisons. The existing Workspace resource service owns current-file preview; it is not a second implementation of historical review.

Native opens require an explicitly independent Host, a base runtime, loopback access, and an available desktop opener. Gateway views retain authorized previews without gaining the server's desktop authority. The file-manager action opens the containing directory through the existing Host method and describes that behavior without promising platform-specific file selection.

## Alternatives considered

- **Compare current files on demand:** would silently replace historical evidence after another edit or deletion.
- **Copy the upstream same-origin HTTP calls:** would send project requests to the Web shell's runtime instead of the Session owner.
- **Keep one cache across retained Sessions:** would retain private data beyond the authorization lifetime and confuse identical Session coordinates on replaced connections.

## Related decisions

Model guidance adopts the upstream Markdown-link format and registered prompt order. The renderer retains inline-code matching for existing transcripts; it does not constrain new responses to files mutated during the same turn.

The [workspace links note](../feature/2026-07-31-web-workspace-file-links.md) still owns the native-open rationale and mutation-location fallback. The [inline mention note](../feature/2026-08-07-web-inline-file-mentions.md) still owns exact-path and unique-basename disambiguation. The [account-scoped sidebar note](2026-09-23-account-scoped-auxiliary-sidebar.md) owns layout and resource identity. These decisions remain active because this adapter does not replace their independent obligations.

## Consequences

The required-on-read event carries a review identity or an incomplete marker without embedding file contents or changing the Session format generation. Storage failures stop further execution; a later explicit request must pass capacity, free-space and write checks. Completed records remain immutable, and already performed file effects are not rolled back. The Web distinguishes unavailable or incomplete review from an empty file list and supports explicit read retry. Pre-persistence history whose scratch data is already gone remains unavailable. Current-file previews retain their independent authorization and lifecycle.
