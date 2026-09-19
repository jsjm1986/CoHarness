# Agent Note: Resume cold sessions for Inbox commands

Status: implemented

English | [中文](2026-09-18-cold-queue-mutation-recovery.zh.md)

## Problem

Inbox state survives in the session log, but `session.updateQueue` previously looked up only a live Agent. After a Host restart, an ordinary persisted Session remains cold until an operation needs its Agent, so editing or removing a restored pending item incorrectly returned `queue-item-not-found`.

## Decision

`session.updateQueue` resolves an ordinary cold Session through the shared Agent resolver (`agentFor`, built by `createApiRemoteAgentResolver`) before reading or mutating its Inbox. A missing persisted Session or an absent persistence backend still maps to `queue-item-not-found`, while other resume failures keep their existing error and subagent ownership keeps the same fence as other Agent operations.

The resolved Agent constructs its Inbox from the registered durable projection. The command therefore reads the restored pending lists and records edits or removals through the existing normalized `agent/inbox/spliced` event. No new session event or on-disk format is introduced.

The shared resolver re-applies the live ownership fence after a settled resume: a shared resume can publish an identity that subagent routing adopts before every waiter observes it, so the post-settle `fencedLiveAgent` check wins over the returned handle.

## Verification

A cold-operation test provides a detached persisted Session with a pending Inbox splice, invokes `session.updateQueue`, and proves that the Session is resumed, the row is removed, and the durable removal splice is appended. A degenerate-composition test proves an absent persistence backend answers `queue-item-not-found`.

## Alternatives considered

**Treat every missing live Agent as a missing queue item.** Rejected because persistence may still own the ordinary Session and its durable Inbox projection.

**Fold the session log inside `session.updateQueue`.** Rejected because the Inbox projection already owns reconstruction, while the shared Agent resolver owns cold lifecycle setup and preset composition.

## Consequences

Operations on restored Inbox rows use the same preset composition, ownership checks, and durable mutation path as operations on live rows. Reading durable state does not itself require eager Agent recovery; only an explicit command resumes the ordinary Agent. `session.cancel` intentionally stays live-only: cancelling a turn on a cold Session is a no-op, not a recovery case.
