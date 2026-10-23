# Agent Note: Cold-history reads recover through a concurrent attach

Status: implemented

English | [中文](2026-09-12-cold-history-attach-race.zh.md)

## Problem

Opening a cold session races its bounded `session.history` read. The walk can finish on the pre-attach revision while the resume's lifecycle events land before the projection baseline folds, and an in-flight creation can outlast one immediate retry. Both windows surfaced to the browser as `history storage is temporarily unavailable` on a session whose log was intact.

## Decision

`historySourceFor` awaits an announced in-flight creation before checking the resident registry on a `dependency` error, then serves the attached session or restarts the detached walk once on the new revision. The tail request also catches `dependency` from the cold projection baseline: when the session attached between the page walk and the fold, the response is cut from the resident log and the stale detached revision pair is dropped from the cache write.

The concurrent post-read revision probe belongs to the history request. Its outcome is observed immediately and joined on every exit, including projection failure, cancellation and attached-source recovery. A rejected probe cannot outlive its request as an unhandled rejection; a successful detached response still uses the matching revision pair for cache admission.

## Alternatives considered

**Retry the whole detached read without checking the registry.** Rejected because the attach already committed the authoritative events; a second detached read still pairs a pre-attach window with a post-attach baseline, and an unbounded retry loop cannot outlast a live session.

**Fold the projection baseline at the detached window's last seq.** Rejected because the resident log already supersedes the window: serving it keeps one consistent revision instead of publishing a cut the store has moved past.

**Abandon the revision probe when another read fails.** Rejected because it can reject after the response has settled and release the request's Runtime lease while its metadata read remains active. Observing the outcome and joining it preserves both error ownership and request lifetime.

## Consequences

A cold `session.history` tail tolerates the open-time attach without client-visible retries, and the tail cache never records a revision pair from a source that changed kind mid-request. A session whose log moves without attaching still reports `dependency` after one restart.

Failed and cancelled requests settle after their already-started revision probe. Controlled projection and persistence barriers verify this ownership without changing history output, issuing another lookup or activating an Agent.
