# Agent Note: Gateway response cancellation cannot postpone revocation

Status: implemented

English | [中文](2026-11-01-gateway-revocation-response.zh.md)

## Problem

A denied terminal recheck is already sufficient to revoke its grant. Awaiting response-body cancellation first keeps the grant and terminal active when cancellation acknowledgement is pending. An invalid authorization update can likewise leave the provider marked ready while its reader cancellation waits. A cancellation error can also replace the original permission denial.

## Decision

The Gateway execution provider requests cancellation of unused bodies and update readers without awaiting acknowledgement. Cancellation throws and rejections are contained independently. A failed check ends its grant immediately; a failed update stream clears readiness and invalidates work before reconnecting. The same response-discard policy applies to execution, SSH, terminal, desktop confirmation and plugin-management refusals.

Authorization cancellation and execution cleanup have separate owners. Revoking a terminal grant triggers the normal TerminalController owner teardown, whose `drainRevoked()` still confirms process cleanup. No model or subprocess permit is released merely because a response was discarded.

## Alternatives considered

**Wait for body cancellation before revoking.** Another response branch or transport cleanup would then control how long revoked work remains authorized.

**Depend on the request signal alone.** A response has already arrived, and its cancellation acknowledgement need not follow the request deadline.

**Treat cancellation failure as the permission result.** A cleanup failure does not change the Gateway decision and must not turn a stable refusal into an unrelated error.

## Consequences

Discarding a response does not prove that its transport is quiescent. The [bounded-reader decision](2026-11-01-gateway-response-cancellation.md) retains read-limit and cancellation semantics, while [confirmed execution cleanup](2026-11-01-uncertain-resource-cancellation.md) continues to own resource accounting. Those decisions remain independent. Public methods, wire fields, Session generations and schemas stay unchanged.

## Verification

Controlled denial bodies keep cancellation pending while terminal grants revoke and admission refuses. A malformed watch stream cancels its owner and refuses new authorization before reader acknowledgement. Cancellation throws and rejections preserve the SSH refusal. Runnable SDK scenarios create an actual PTY child, retain the failed-response acknowledgement, observe the child exit after revocation and deny another terminal. Both SDKs pin those results. Complete original provider packages retain authorization or the process until acknowledgement is released.
