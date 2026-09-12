# Agent Note: Cold-history reads recover through a concurrent attach

Status: implemented

English | [中文](2026-09-12-cold-history-attach-race.zh.md)

## Problem

Opening a cold session races its bounded `session.history` read. The walk can finish on the pre-attach revision while the resume's lifecycle events land before the projection baseline folds, and an in-flight creation can outlast one immediate retry. Both windows surfaced to the browser as `history storage is temporarily unavailable` on a session whose log was intact.

## Decision

`historySourceFor` awaits an announced in-flight creation before checking the resident registry on a `dependency` error, then serves the attached session or restarts the detached walk once on the new revision. The tail request also catches `dependency` from the cold projection baseline: when the session attached between the page walk and the fold, the response is cut from the resident log and the stale detached revision pair is dropped from the cache write.

## Alternatives considered

**Retry the whole detached read without checking the registry.** Rejected because the attach already committed the authoritative events; a second detached read still pairs a pre-attach window with a post-attach baseline, and an unbounded retry loop cannot outlast a live session.

**Fold the projection baseline at the detached window's last seq.** Rejected because the resident log already supersedes the window: serving it keeps one consistent revision instead of publishing a cut the store has moved past.

## Consequences

A cold `session.history` tail tolerates the open-time attach without client-visible retries, and the tail cache never records a revision pair from a source that changed kind mid-request. A session whose log moves without attaching still reports `dependency` after one restart.
