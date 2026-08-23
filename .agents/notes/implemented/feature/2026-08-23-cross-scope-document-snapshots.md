# Agent Note: Cross-scope document snapshots

Status: implemented

English | [中文](2026-08-23-cross-scope-document-snapshots.zh.md)

## Problem

Personal and project document stores belong to different runtime processes and their document ids are store-scoped. Passing a path or a live reference across that process boundary would bypass the runtime filesystem policy and would make later prompt replay depend on a foreign store.

## Decision

Cross-scope document movement is an explicit version-1 Gateway broker operation. A request names a personal or project source and target, but the active runtime must be one endpoint of the transfer. Personal-to-project copies require project `rw` authority; project-to-personal copies require project read authority. Project-to-project and same-scope transfers are refused.

The Gateway opens each source document through its loopback runtime endpoint and streams the response directly into the target runtime upload endpoint. The browser receives only safe per-file metadata and never receives source bytes. The target store resolves a fresh name, so collisions use its ordinary non-overwriting suffix policy. Each file commits independently; a failed item does not remove prior successful copies.

The response and audit record carry a transfer id, source and target scope labels, source document id/name, target document id/name, byte count, and result code. Absolute paths and internal runtime identifiers remain in Gateway audit details only. The transfer request and response are versioned so a future protocol can be introduced without silently changing v1 semantics.

The document HTTP consumer applies the same project membership mode check to listing, reads, uploads, folder operations, moves, and deletes. Missing project collaboration authority fails closed as an unavailable authorization service. The Web manager can copy selected documents to a writable project or to the personal store, and successful target refs can be attached to the active composer as non-owning durable drafts. Removing such a draft never deletes the copied file.

The broker also exposes a metadata-only alternate-scope listing and a capability projection. Alternate rows cannot be downloaded, previewed, moved, or deleted through the active runtime; they can only be selected for a permitted snapshot copy.

## Verification

Focused Host document tests cover personal behavior, project `ro` read/write ACLs, missing collaboration, transfer metadata forwarding, and route errors. Gateway tests cover streaming personal-to-project and project-to-personal transfers, read-only denial, malformed and unsupported scope requests, per-file failure isolation, safe metadata, and runtime-principal enforcement. Client tests cover target selection, copy results, and composer attach callbacks.

## Alternatives considered

**Share a live path or document id between runtimes.** Rejected because the id is store-scoped and the path would bypass the target runtime's filesystem policy.

**Send source bytes through the browser.** Rejected because it exposes project content to a client data plane and duplicates transfer buffering; the Gateway already has authenticated access to both loopback endpoints.

**Maintain live synchronization.** Deferred because it would require conflict resolution, source deletion semantics, and a second durable event protocol; v1 needs an explicit snapshot with a clear commit point.

## Consequences

Copies are immutable snapshots with no live synchronization. A later source edit is independent of the target, and a target remains usable after the source scope is unavailable. Gateway availability is required for cross-scope operations; ordinary personal document uploads continue to work in standalone compositions.
