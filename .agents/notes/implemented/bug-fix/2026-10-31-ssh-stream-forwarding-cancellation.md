# Agent Note: SSH stream rollback retains transport ownership

Status: implemented

English | [中文](2026-10-31-ssh-stream-forwarding-cancellation.zh.md)

## Problem

A caller can cancel while a completed forwarding command returns its infrastructure permit. The Unix listener already exists even when no client socket was allocated. Ignoring a failed cancellation or path removal leaves a reusable connection owning unconfirmed forwarding resources.

## Decision

The [SSH connection](../../../../packages/ssh/ssh/src/index.ts) includes the post-command cancellation check in reservation rollback. A rollback failure invalidates the connection, terminates its native master and joins native process observation. Allocation, rollback and observation failures retain their independent errors. Unconfirmed native cleanup retains the private directory.

Normal enclosing disposal still drains consumers before stopping the master. Stream cleanup must not await enclosing disposal: a retained consumer can be waiting for that stream allocation. Failed rollback can join the native master directly because connection invalidation has already requested its termination.

## Alternatives considered

**Unlink the socket without confirmed cancellation.** An OpenSSH listener can remain allocated independently of its pathname.

**Await connection disposal from stream cleanup.** The allocation and its retained consumer can form a cleanup dependency cycle.

## Consequences

Confirmed rollback preserves a healthy connection. Unconfirmed rollback refuses new work and keeps failures visible. Protocol fields and helper digests are unchanged by this Host-only fix. [Subprocess admission ownership](2026-10-31-subprocess-admission-owner.md) and [helper cleanup retry](2026-10-31-ssh-helper-cleanup-ownership.md) remain separate ownership decisions.

## Verification

Startup tests exercise cancellation during native permit completion, cancellation and unlink failures, and unconfirmed native cleanup. The [assembled expected-output test](../../../../packages/ssh/ssh/tests/stream-forwarding.expected.e2e.ts) runs a Loader, native OpenSSH carrier stand-in and actual helper; it observes socket removal, request refusal and native permit completion without a model API.
