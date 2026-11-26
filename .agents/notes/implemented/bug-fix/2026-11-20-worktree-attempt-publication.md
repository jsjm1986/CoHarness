# Agent Note: Worktree attempt result publication

Status: implemented

English | [中文](2026-11-20-worktree-attempt-publication.zh.md)

## Problem

When Git rejected a retry, the [Forge panel](../../../../packages/experimental/client-ui-forge/README.md) first published that the attempt had ended, followed by its failure. WebKit could hold the second frame until unrelated stream traffic arrived. The card showed a stopped attempt while the actual failure and its Git output were pending.

## Decision

A held attempt transfers ownership of its final publication to the waiting message. It publishes the stopped or failed result after the next retry can be accepted. The browser uses the recorded request and creation to close the card once the request is withdrawn or satisfied.

## Alternatives considered

**Send the end of the attempt and then its result.** The interim state makes a failed attempt appear stopped and can expose Retry before the hold can accept it.

## Consequences

Subscribers receive an actionable result for a failed or stopped attempt. Continuing in the source checkout and entering a created worktree both clear the creation card from the same state that records the decision.

## Verification

The opt-in browser replay stops a held Git invocation, deletes the selected base branch, retries, reads the Git failure, and continues the message in the original checkout. A second Session creates its worktree and sends its first message from the new directory.
