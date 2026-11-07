# Agent Note: Atomic file acquisition

Status: implemented

English | [中文](2026-10-26-atomic-file-acquisition.zh.md)

## Problem

An exclusive temporary-file creation can fail because another writer already owns its path. Cleanup that removes that path after the failed creation deletes another writer's data. A partially written lock can also retain the current process's PID after its creation fails, preventing subsequent writers from entering. Independent descriptor-close and cleanup failures must remain available with the original failure.

## Decision

Atomic replacements, writer locks and recovery claims acquire a file descriptor through exclusive creation. That successful acquisition owns the file's write, optional operating-system account assignment and close. A failed acquisition leaves the occupying entry intact. A failed write, account assignment or close removes the acquired file; multiple failures are retained together. A completed temporary file transfers to the replacement operation, which removes it if replacement fails and retains any additional cleanup failure.

Callers may supply an explicit numeric user and primary group for a privileged writer. The account applies before the replacement is published or the locked operation begins, including recovery claims. The caller resolves the account and provisions directories. File ownership supplies operating-system access; application authorization remains the responsibility of the owning service.

Atomic replacement accepts a caller-owned cancellation signal. It checks that signal before preparation and every rename attempt, including retries. Cancellation after temporary bytes are written removes only the acquired temporary file and preserves the committed target. The owning service supplies lifetime authority; cancellation cannot undo a rename already issued. Remote desktop administration uses this signal when its retained PostgreSQL connection is lost.

The durable node configuration writer follows the same acquisition rules while retaining file and directory synchronization. Cleanup owns the staging pathname only after exclusive open succeeds and before rename publishes it. A foreign entry created at the old staging name after publication remains untouched. Descriptor disposal retains a primary I/O failure together with an independent close failure.

The [document operation drain decision](2026-10-26-document-operation-drain.md) retains the corresponding rules for document-owned staging files. This decision applies those rules to the shared atomic-write library used by settings and other persisted domains.

## Alternatives considered

**Remove the temporary path after every creation failure.** An error does not prove ownership of that path, including a failed exclusive create.

**Assign ownership after replacement.** Another process can observe the new file before it has the required access, and assignment failure leaves a published replacement that its intended account cannot use.

## Consequences

A failed operation retains the previous target and any foreign temporary entry. Cleanup failures can retain an acquired temporary file for diagnosis and appear alongside the original failure. Deterministic filesystem faults verify collision retention, partial writes, descriptor close, cleanup, account assignment and recovery claims. Supported Node source and emitted-library checks supplement these cases; cross-account Linux confinement requires separate platform evidence.
