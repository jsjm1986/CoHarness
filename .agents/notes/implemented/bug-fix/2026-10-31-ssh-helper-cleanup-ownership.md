# Agent Note: SSH helper cleanup remains owned through failed attempts

Status: implemented

English | [中文](2026-10-31-ssh-helper-cleanup-ownership.zh.md)

## Problem

A direct process result can settle before endpoint and directory cleanup. A repeated close that returns before the active cleanup finishes falsely acknowledges completion. Removing a failed cleanup task, caching its rejected promise permanently, or deleting its provider and private evidence prevents recovery after a temporary failure.

## Decision

[Remote process ownership](../../../../packages/ssh/ssh/src/helper-processes.ts) retains stable, idempotent cleanup callbacks until success. Overlapping close calls share one attempt; failure retains callbacks for retry while admission stays closed. Finalized processes retain their original direct result independently of pending resource cleanup.

The [helper](../../../../packages/ssh/ssh/src/helper.ts) keeps its local providers and private root while process cleanup is unconfirmed. A later close request may retry cleanup, including a failed final root removal. Ordinary effects remain refused, and cleanup never replays a program operation.

## Alternatives considered

**Drop tasks in a `finally` callback.** Failed resource cleanup disappears from later shutdown attempts.

**Keep a rejected promise as permanent completion.** Repeating close cannot recover when the external failure clears.

**Dispose providers and private directories in `finally`.** Consumers can still need those dependencies and native ownership evidence.

## Consequences

Failures remain visible until cleanup succeeds. A failed process-range observation retains its owner, and successful process results remain readable through their existing bounded cache. Host carrier shutdown retains its separate transport-loss behavior. Protocol 2 and request fields stay compatible; installing the rebuilt helper requires its new verified digest.

## Verification

Real native success and failure tests hold directory cleanup while repeated close calls wait, then inject recoverable removal failures. The [Loader example](../../../../packages/ssh/ssh/tests/fixtures/cleanup-recovery.mjs) runs the actual helper wire program, retries reservation and root cleanup, verifies refusal of new work, and confirms native exit before resource completion.
