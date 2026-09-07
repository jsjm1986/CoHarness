# Agent Note: Recover orphaned user-document admission locks

Status: implemented

English | [中文](2026-09-07-userdoc-orphan-admission-lock.zh.md)

## Problem

The local resumable-upload provider serializes admission and expired-session cleanup with a PID-bearing file lock. A runtime stopped while holding that lock leaves the file behind. The generic file-lock utility deliberately never removes an existing lock, so every later document listing waits for the provider's 30-second lock deadline before failing. A project-scope listing then reaches the Gateway's matching upstream timeout and appears as a slow scope switch.

## Decision

The local provider checks its admission lock during startup cleanup. When the lock contains a numeric PID and that process no longer exists, the provider atomically renames the lock to a process-specific temporary name and removes the temporary file before acquiring a new lock. A live, malformed, unreadable, or concurrently removed lock remains under the generic contention rules. The recovery is limited to the provider's admission lock; other file locks keep the utility's operator-recovery semantics. The document manager maps an HTML 5xx proxy body to its localized runtime-unavailable message instead of rendering proxy markup as an error.

## Alternatives considered

**Change the generic file-lock utility to reclaim old locks.** Rejected because lock age and PID reuse cannot establish ownership for every caller; broad recovery would weaken unrelated credential, settings, and manifest coordination.

**Delete the admission lock unconditionally at startup.** Rejected because another runtime can still be completing an admission operation while a replacement process starts; removing a live lock could admit conflicting uploads.

**Keep operator-only recovery.** Rejected because an orphaned admission lock blocks ordinary reads as well as writes, and the failure presents as a repeated 30-second document-list timeout rather than an actionable upload error.

## Consequences

An interrupted runtime can recover its document listing on the next startup without operator cleanup when the recorded owner PID is no longer live. Atomic rename keeps recovery safe against another process observing the same lock, while live and unreadable locks continue to fail closed. The lock file remains a private implementation detail, and a proxy-generated HTML failure no longer leaks into the document panel; document bytes, session records, and successful HTTP responses remain unchanged.

Focused upload, local-store, and atomic-write tests cover the recovery and existing lock contention behavior; the deployed project-6 orphan lock was isolated and its listing returned HTTP 200 in 44 ms after recovery.
