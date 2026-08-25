# Agent Note: Target-scope document uploads

Status: implemented

English | [中文](2026-08-26-scoped-document-upload.zh.md)

## Problem

The Web document manager could list another authorized scope as metadata, but its upload route always followed the active runtime scope. Switching the global collaboration scope reloads the page and changes the conversation runtime, while uploading to a read-only source would violate the scope distinction.

## Decision

The Gateway owns a separate resumable upload subtree at `/api/documents/transfer/uploads`. Each browser request carries a compact `scope=personal` or `scope=project:<id>` query. The Gateway resolves the selected runtime, rechecks project `rw` authority on every lifecycle request, signs a target-runtime principal, and forwards metadata and chunk bodies without buffering the file. Session responses contain safe metadata only; absolute paths and loopback authorities are removed.

The shared browser uploader accepts a request query and a resume namespace. The namespace participates in the IndexedDB/localStorage key so one browser file can resume independently in multiple document scopes. Existing current-runtime uploads keep the original route and behavior.

The document manager treats a selected non-current scope as an upload target with metadata-only browsing. Writable targets enable upload into their root directory; folder management, preview, download, move, delete, and attach remain bound to the active runtime. Read-only projects stay visible with a disabled upload state. Source browsing remains a separate read-only mode, and the all-scope overview requires an explicit writable target.

This extends the cross-scope snapshot and resumable-upload decisions recorded in [cross-scope document snapshots](2026-08-23-cross-scope-document-snapshots.md) and [resumable user-document upload](../architecture/2026-08-25-resumable-user-document-upload.md); their copy and current-runtime storage guarantees remain unchanged.

## Alternatives considered

**Switch the global collaboration scope.** Rejected because `/account/api/scope` reloads the page and changes the active conversation runtime for a document-only action.

**Upload to the current runtime and copy a temporary document.** Rejected because it creates intermediate files, fails when the current scope is read-only, and complicates cleanup and provenance.

**Expose the selected runtime's upload port or path to the browser.** Rejected because runtime authorities and filesystem paths are private Gateway facts; the Gateway broker already provides authenticated loopback forwarding.

**Make metadata-only alternate views fully writable.** Rejected because preview, download, move, delete, and attachment operations require a store identity that the active conversation does not share; only explicit target upload is added.

## Consequences

Target uploads do not reload the Web page and can start a project runtime on demand. Every upload request performs an authorization lookup, so membership changes take effect during an in-progress session. Target uploads land at the target scope root; current-scope folder uploads retain breadcrumb behavior. The Gateway adds no database state, but deployments must release the target-upload route before clients that call it.
