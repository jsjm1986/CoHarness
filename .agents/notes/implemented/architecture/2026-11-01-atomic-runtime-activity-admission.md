# Agent Note: Atomic Runtime activity admission

Status: implemented

English | [中文](2026-11-01-atomic-runtime-activity-admission.zh.md)

## Problem

Concurrent metadata requests enter one Runtime lifecycle queue. Separate eligibility, state, generation and activity queries multiply database round trips while retaining that queue, so a distant database delays otherwise independent metadata operations.

## Decision

The instance repository admits HTTP and WebSocket activity with one conditional activity update. It checks organization, assigned computer, owner, provisioning, readiness, node execution credentials and the captured generation when supplied. Personal assignments also require an active account and organization membership with computer use permission; project assignments require an active project. Caller authorization remains with the Gateway route and its publication checks.

An exact Runtime identity enters its lifecycle queue directly; the conditional update verifies its owner and computer association. Owner-only selectors first resolve an unambiguous assignment. No identity or eligibility result is cached between requests.

The manager retains an in-memory reference only after the activity update succeeds. Start, stop, idle reaping and admission keep the same Runtime queue. Release removes the reference before its activity write, and a failed write cannot restore a released reference. Omitting a captured generation accepts the currently ready generation.

Warm routing reads the exact assignment, state, port and generation in one database snapshot, then checks that captured generation's actual supervisor and resource registration. A reattached supervisor is published only after another snapshot confirms the same ready generation and port. A retained older supervisor cannot serve a replacement generation, including without resource accounting. The returned endpoint is an observation, not an authorization grant: forwarding still requires captured-generation activity admission and current route permissions.

An expired managed node connection cannot authorize its existing Runtime. On re-entry, failed start eligibility can claim stop intent only when a conditional update proves that exact generation still has an invalid managed connection. The lifecycle queue then confirms physical termination before rechecking eligibility and using ordinary startup to issue a fresh generation and credential. Administrator-initiated recovery retains current administrator authority. Uncertain termination keeps the assignment stopping and preserves its occupation; an offline node cannot start a replacement. Directory reads do not enter this recovery path.

## Alternatives considered

**Cache eligibility or generation.** Revocation and replacement must affect the next admission. A cache would need a separate authority invalidation mechanism and would duplicate the repository's current facts.

**Parallel reads followed by a separate write.** This preserves multiple database statements and permits the checks and activity mutation to observe different states.

**Move admission outside the lifecycle queue.** Idle reaping or stopping could pass between durable admission and reference retention. The single statement reduces queue occupancy while preserving that ordering.

**Read endpoint fields independently.** Separate assignment, state, port and generation reads add database round trips and can combine values from different observations. One snapshot keeps those fields together without caching permissions or bypassing supervisor checks.

**Rebind an existing Runtime to a renewed node lease.** This would revive a credential whose original connection lost authority. Confirmed termination and a fresh generation preserve the connection checks while retaining the same Runtime identity, local files and Session data.

## Consequences

An exact assignment needs one admission statement without weakening its predicates. Refused admission leaves both activity and reference counts unchanged. Existing authority checks still govern operations and response publication after admission. No schema, Runtime identity or Session generation changes are required.
