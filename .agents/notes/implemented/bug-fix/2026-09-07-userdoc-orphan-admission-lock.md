# Agent Note: Recover orphaned user-document admission locks

Status: implemented

English | [中文](2026-09-07-userdoc-orphan-admission-lock.zh.md)

## Problem

The local resumable-upload provider serializes admission and expired-session cleanup with a PID-bearing file lock. A runtime stopped while holding that lock leaves the file behind. The generic file-lock utility deliberately never removes an existing lock, so every later document listing waits for the provider's 30-second lock deadline before failing. A project-scope listing then reaches the Gateway's matching upstream timeout and appears as a slow scope switch.

## Decision

The local provider checks the actual `.admission.lock` sibling created by `withFileLock` during startup cleanup. Only an `ESRCH` process probe proves that its recorded owner is gone; malformed identities, permission errors and other indeterminate probes never authorize recovery. Recoverers serialize through a separate `.admission.lock.recovery.lock`, then re-read the admission owner before atomically renaming and removing the orphan. A second startup therefore cannot act on its earlier observation after another writer acquires admission. Existing writers retain the generic lock utility's exclusion rules.

Recovery is limited to admission. An interrupted recovery can leave its coordination lock behind; that lock requires operator verification and removal instead of recursive automatic reclamation. The document manager maps an HTML 5xx proxy body to its localized runtime-unavailable message instead of rendering proxy markup as an error.

## Alternatives considered

**Change the generic file-lock utility to reclaim old locks.** Rejected because lock age and PID reuse cannot establish ownership for every caller; broad recovery would weaken unrelated credential, settings, and manifest coordination.

**Delete the admission lock unconditionally at startup.** Rejected because another runtime can still be completing an admission operation while a replacement process starts; removing a live lock could admit conflicting uploads.

**Keep operator-only recovery.** Rejected because an orphaned admission lock blocks ordinary reads as well as writes, and the failure presents as a repeated 30-second document-list timeout rather than an actionable upload error.

## Consequences

A runtime interrupted during admission can recover document listing on startup when the owner is provably gone and recovery coordination is available. Recovery does not change document bytes, Session records, successful HTTP responses, or upload reservations.

Regression tests seed the real lock filename with a child process's PID after that child exits. A barrier-controlled pair of startups observes the same orphan, then verifies the replacement writer's lock remains intact and admission stays exclusive. Live, malformed and unprobeable identities remain untouched. The assembled Web provider restart and document HTTP route exercise the same recovery path.
