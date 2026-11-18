# Agent Note: Personal restore retry settles on refresh failure

Status: implemented

English | [中文](2026-11-18-personal-restore-retry-settles-on-refresh-failure.zh.md)

## Problem

`personal-directory`'s `refresh(true)` arms `selectionRetry` so that the pending saved-selection restore resumes when the directory next settles. Only the success path consumed the flag: after `restoredDirectory` republished, `restoreSelection(retry)` ran the armed intent's `prepare` again. A transient catalog failure — deadline abort, network drop, 5xx — took the `catch` branch, set the directory error state, and returned with the flag still armed. Nothing else in the failure path calls `restoreSelection(true)`, so the armed retry waited for an unrelated trigger (a later `online`, `focus`, host-description or account publication) to be consumed.

In the `personal-navigation-resume` e2e the synthetic `online` event drove exactly this sequence: the catalog refresh failed transiently, the retry stayed armed, and the conversation intent sat in `unavailable` phase until the assertion timed out. The intent's own retry affordance still worked — the failure stranded only the automatic resume.

## Decision

The `refresh` failure path now consumes `selectionRetry` and runs `restoreSelection(retry)`, mirroring the success path. A failed refresh is still a settle: the last published `restoredDirectory` remains the retry's catalog, and `available()` inside the restore decides whether the target is described by it. The 401/403 branch already cleared the live directory; resuming against the last catalog under revoked access simply fails the intent's own `open` again and lands on the same `unavailable` phase.

## Alternatives considered

**Reschedule the refresh with a delay.** A timer owns retry pacing for every caller, but the failure path has no cadence contract today and the armed retry's correct settle is the intent's own availability check, not another fetch.

**Leave the flag armed until a later publication.** That is the status quo the failure exposed: the trigger is unrelated to the restore and may never arrive before the document closes.

## Consequences

Automatic saved-selection resume is no longer stranded by one transient catalog error after `online`/`focus`. Consumers of `setDirectoryState('error')` are unchanged; the resume attempt reuses the existing `prepare`/`open` path and fails visibly through the same intent phases. This completes the settle contract of [the armed selection retry](../architecture/2026-11-16-personal-restore-retry-outlives-carrier-refresh.md): the flag is now consumed by whichever refresh settles the directory, success or failure, instead of only the one that publishes it.

## Verification

`personal-navigation-resume`'s offline→online round trip covers the armed retry end to end: the intent resolves, the unsent draft transfers, and the history read lands on the original runtime. The failure-settle consumption is exercised by the same spec whenever the post-`online` catalog fetch loses.
