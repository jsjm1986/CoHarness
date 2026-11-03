# Agent Note: Workspace publication order belongs to the application

Status: implemented

English | [中文](2026-11-01-workspace-publication-revision.zh.md)

## Problem

The Gateway retains Workspace metadata only when its `(generation, revision)` is newer than the stored publication. A publisher-local revision restarts at one when the registry or Gateway transport is replaced inside the same application. The Gateway can acknowledge the request while retaining older metadata, and an already accepted older request can overwrite a replacement whose numbering restarted.

## Decision

One root-owned sequence supplies every Workspace publication in an application. Individual publisher scopes own cancellation and serialization, while the sequence survives both registry and transport-provider replacement. Allocation occurs synchronously before issuing the request, so an abandoned request always has a smaller revision than its replacement. Exhaustion of the protocol's safe-integer range fails without wrapping.

The sequence is registered through a root effect and retained as data by active publishers. Unregistering the root contribution does not invalidate a captured sequence. Launch identity remains application-owned, and the Gateway continues to enforce its independent runtime-generation and current-computer checks.

## Alternatives considered

**Keep a counter on the registry or transport provider.** Either owner can be replaced while the authenticated generation stays unchanged.

**Use wall-clock time.** Clock rollback and equal timestamps cannot establish the ordering of admitted requests.

**Change the Gateway to accept lower revisions.** A late old request could then replace current metadata.

**Persist another local sequence.** The application already retains its launch identity through provider replacement. Cross-process ordering belongs to the Gateway generation rules; this repair needs no storage schema or new protocol.

## Consequences

The HTTP response, catalog fields, credentials and database schema stay unchanged. A stopped publisher retains no listener or request admission, while a replacement shares its application's publication order. The [workbench decision](../architecture/2026-09-08-cordis-multi-session-workbench.md) retains Workspace identity and viewing semantics; archive revisions and their ownership remain independent.

## Verification

Scoped registry replacement advances revisions from one and two to three. An abandoned old request cannot replace the new snapshot when it completes late. Root isolation, safe-integer exhaustion, failed-publication retry and teardown callbacks retain their lifecycle rules. Real PostgreSQL retains the replacement metadata and refuses another account and stale generation. Both SDKs run actual Workspace storage and Gateway transport replacements through the shipped profile; complete original Runtime packages preserve the old catalog and fail the same scenarios.
