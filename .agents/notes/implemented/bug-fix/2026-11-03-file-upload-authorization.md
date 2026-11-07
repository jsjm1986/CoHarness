# Agent Note: File uploads require Session permission and live owners

Status: implemented

English | [中文](2026-11-03-file-upload-authorization.zh.md)

## Problem

Binary uploads use a Connection HTTP subtree, which does not execute the ordinary Remote Session authorization. Browser authentication alone cannot grant write access to a private or read-only conversation. An upload can also outlive its service or lose an idle Agent while bytes are still arriving.

## Decision

The [Host service](../../../../packages/client/file-upload/src/index.ts) captures the original collaboration provider and participant for both transports. It authorizes write access before cold lookup and storage, then rechecks the same provider, caller, exact Agent and current permission before publishing a receipt. A required provider cannot disappear into independent access. Refusals use the existing `collaboration-forbidden` result.

Accepted storage holds a permanent-removal reservation and an exact-Agent idle veto. These protect different lifecycle operations: a removal reservation alone cannot prevent idle disposal. A composed effect retains the veto until service cancellation and accepted storage settle. Node HTTP inputs close on cancellation; custom iterable producers own settlement of their pending reads. Completed immutable bytes can remain after cancellation or final authorization failure, without a staged receipt.

## Alternatives considered

**Enforce only at the Remote gateway.** The binary HTTP route and direct Host consumer do not enter that gateway.

**Check once or recapture after storage.** Permissions can change while uploading, and recapture can substitute another participant for the original caller.

**Release the Agent when cancellation is requested.** Storage cleanup can still be active; admission remains closed until that work settles.

## Consequences

Raw and encoded uploads share one authorization rule. Independent local applications retain their existing upload behavior. Plugin unload removes the route and command resolver, rejects retained upload references and waits for accepted storage. Receipt binding and rollback for already admitted prompts remain usable for cleanup.

## Verification

The real Loader [example](../../../../packages/client/file-upload/tests/fixtures/managed-authorization.mjs) uses signed Gateway principals, PostgreSQL permissions, real Agents and local immutable storage. It verifies owner success, private and read-only refusals, mid-stream revocation, caller cancellation, service withdrawal, temporary-file removal and idle protection. Unit coverage exercises queued provider changes, exact-Agent replacement, retained service references and receipt binding through the real command registry.
