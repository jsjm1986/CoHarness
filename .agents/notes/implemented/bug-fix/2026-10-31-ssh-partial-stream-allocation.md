# Agent Note: Failed SSH startup owns every stream attempt

Status: implemented

English | [中文](2026-10-31-ssh-partial-stream-allocation.zh.md)

## Problem

Parallel stream allocation can fail while sibling attempts still own native forwarding commands. Keeping sockets only after `Promise.all()` succeeds loses partially allocated sockets. Remote termination can be acknowledged before local startup cleanup finishes, allowing premature process-permit completion and provider disposal.

## Decision

The [SSH subprocess provider](../../../../packages/ssh/subprocess-ssh/src/index.ts) records each authenticated socket immediately. Failed startup cancels sibling attempts, waits for every attempt and observes all allocated socket closures before rejecting its result. A confirmed remote range does not complete observation while startup remains unsettled. Provider disposal also joins socket closure after stopping a successfully started process.

Cancellation of an observation remains bounded. An incomplete observation retains uncertain accounting; later confirmation can complete the original permit. Termination errors remain available through range observation independently of the original startup failure.

## Alternatives considered

**Keep only the successful aggregate result.** A rejected sibling discards completed sockets and permits cleanup to finish while another attempt is still running.

**Treat remote termination acknowledgement as completed startup.** Local forwarding subprocesses and sockets can still belong to that allocation.

## Consequences

Failed startup retains its original error and refuses process launch. Transport cleanup finishes before request admission is completed. Wire fields and the helper digest remain unchanged. [Admission ownership](2026-10-31-subprocess-admission-owner.md), [Host forwarding rollback](2026-10-31-ssh-stream-forwarding-cancellation.md) and [helper cleanup retry](2026-10-31-ssh-helper-cleanup-ownership.md) retain their independent responsibilities.

## Verification

Public-provider cases hold sibling rejection or late grants and socket closure, checking result, observation, disposal and original permit completion. The [Loader expected-output application](../../../../packages/ssh/subprocess-ssh/tests/partial-stream-allocation.expected.e2e.ts) holds an actual native forwarding control process after another stream fails and observes ownership before releasing it. No model API is required.
