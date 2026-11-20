# Agent Note: Project reservation authority for private drafts

Status: implemented

English | [中文](2026-11-17-project-reservation-draft-authority.zh.md)

## Problem

[Deferred Session materialization](../architecture/2026-08-26-session-draft-lifecycle-and-content-watermarks.md) intentionally leaves a new project conversation without a Session row before its first message. Requiring that row to save private browser text or verify an attachment target prevents both operations on a valid new conversation.

## Decision

The authenticated node draft provider accepts either ordinary Session authority or an exact live reservation owned by the requesting creator. A reservation matches organization, project, Runtime and Session, excludes every existing Session row and unrestored archive identity, and requires current account, computer and project write authority. Administrator status does not confer ownership of another creator's unmaterialized reservation. Private text retains the existing account, Session and tab keys.

Final reservation reads and writes hold the shared form of the Session materialization advisory lock before retaining the reservation row. Nonblocking acquisition avoids waiting behind a materializer or an archive operation while the read holds its ACL revision. The final statement rechecks expiry and identity; cancellation cannot commit across a retained reservation. A local content transaction is passed to the final authorization callback, so bounded pools never wait for a second connection held by the same read.

Attachment checks try this read-only capability only when the ordinary exact-Session check returns false. Existing permission errors propagate. A closed, deleted, private or archived materialized Session cannot obtain access through its former reservation. These checks read no message or draft text and start no Runtime.

## Alternatives considered

**Materialize every new conversation.** Rejected because abandoned drafts would acquire durable Session identities and bypass the deferred lifecycle.

**Treat project membership as sufficient for a missing Session.** Rejected because membership does not prove who owns the reserved conversation. The reservation creator and current authority are both required.

**Check the reservation only in the initial snapshot.** Rejected because cancellation, expiry and first materialization can happen before disclosure; Session insertion does not increment the visibility revision.

## Consequences

New project conversations accept private drafts and document targets without expanding collaboration access. Contention returns a retryable storage failure instead of waiting with conflicting locks. Expired reservations keep stored private text but cannot authorize its disclosure.

## Verification

The keyless Gateway transcript uses authenticated HTTP requests and separate governance/content databases for reservation, two private tab drafts, attachment verification, first append and history. Real PostgreSQL cases cover cancellation and materialization on both sides of final admission, expired reservations, withdrawn computer permission, another account, and materialized private, closed, deleted and archived identities. HTTP route regressions retain legacy handler authorization.
