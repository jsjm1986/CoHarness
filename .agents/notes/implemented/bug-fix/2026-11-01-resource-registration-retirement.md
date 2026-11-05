# Agent Note: Unsubmitted resource requests retire independently of remote registration

Status: implemented

English | [中文](2026-11-01-resource-registration-retirement.zh.md)

## Problem

One Runtime serializes remote resource identities while several callers resolve ownership and wait for capacity. A failed origin or a cancelled request that has not reached the Gateway must settle and release its local queue capacity without waiting for an earlier HTTP request. Attempted registrations have a different obligation: their reservations need exact completion acknowledgement.

## Decision

Origin preparation remains bounded and starts in the caller’s scope. Validated entries enter a removable ready set served by one serial registration drain. Origin failure and cancellation before submission remove local ownership immediately. Cancellation of an attempted registration retains its original completion path and accounting uncertainty. Disposal cancels and joins the same owned preparation and registration work.

An active registration is a capacity reservation. Before delivering its lease, the provider requests a fresh qualification of the captured origin after the node transaction releases its connection. Immediate registrations and active results from a multi-operation poll get an exact-operation check. Authorization for one result in a batch can age while the Gateway checks another result. Refusal reports the exact operation as not started and releases its unused occupation.

## Alternatives considered

**Reject the caller but keep its queue entry.** The abandoned entry can refuse a different caller with a full-queue error.

**Remove entries but retain one chained registration callback per request.** Cancelled callbacks still accumulate behind a slow HTTP request. A removable ready set keeps waiting ownership bounded.

## Consequences

Operation identities are assigned serially after ownership resolution. A valid request can register while another caller still resolves its origin. Wire messages, committed policy, exact completion identities and Session data stay unchanged. This queue grants no execution permission; the Gateway still requalifies admitted ownership.

## Verification

Controlled HTTP responses exercise immediate origin refusal, cancellation before submission, reusable local capacity and consecutive remote identities. Real PostgreSQL checks include revocation while a registration waits for the actual node-row lock. The initial active reservation cannot start a process after account, membership, computer or administrator-role withdrawal; restored authority can execute afterward. Runnable SDK compositions verify request results, exact registered operations and released permits with both language clients; complete original source and built providers reproduce the failures.
