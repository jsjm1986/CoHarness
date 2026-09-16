# Agent Note: Post-commit fsync failure is not a write failure

Status: implemented

English | [中文](2026-09-16-write-atomic-post-commit-fsync.zh.md)

## Problem

`writeAtomic` treated a post-`rename` `fsync` failure the same as a pre-commit error: it cleaned the temp file (already renamed away) and re-threw, so the caller rolled its in-memory state back to the previous value while the file on disk already held the new content — a media/memory fork.

## Decision

The parent-directory `fsync` after `rename` is best-effort: the rename already committed the new content, so the failure is contained and the write returns success. Only errors before the commit point reject the write; the helper is a leaf utility with no diagnostic channel, so the swallowed failure is named at the `catch`.

## Alternatives considered

**Propagate the fsync failure anyway.** Rejected: the caller cannot act on it — rolling back memory while disk holds new content is strictly worse than accepting the committed write.

**Delete the new file to restore the old state.** Rejected: the previous value is already gone — the rename replaced it — so "restoring" would require a rewrite and adds a second failure mode to the recovery path.

## Consequences

A durable-but-failed-fsync write reports success, matching what is actually on disk; the weakened-durability signal is local to the `catch` comment, since `writeAtomic` has no logger to surface it through.

## Verification

`json-backend.spec.ts` covers the split: a pre-commit failure rejects and rolls back, while a post-rename fsync failure is contained and the backend retains the committed state.
