# Agent Note: Runtime control retains the initiating administrator

Status: implemented

English | [中文](2026-10-29-administrator-runtime-control.zh.md)

## Problem

An authenticated Runtime control request can outlive its administrator's authority during target lookup, lifecycle serialization, resident admission, policy preparation or node-pressure admission. Sharing pending starts across administrators can also give a revoked caller another administrator's result. A repository-capacity refusal requires a service-unavailable response rather than an internal-error response.

## Decision

The [Admin router](../../../../gateway/src/admin-api.ts) supplies its server-authenticated administrator id to personal and project start, stop and restart. Body fields cannot select that actor. [`InstanceManager`](../../../../gateway/src/instances.ts) separates pending starts by target, intent and initiating administrator. Explicit control checks current authority after serialization and admission waits, before queued-start cancellation, before terminating an older tracked handle, and before final allocation or warm handoff.

The [PostgreSQL repository](../../../../gateway/src/postgres/instance-repository.ts) holds current organization, account and administrator-membership locks through start or stop intent. Final personal admission reads the current owner policy within the same administrator transaction; checking these two independently would leave one stale while awaiting the other. SQLite makes the corresponding reads and writes within immediate transactions. Database connections and authority locks are released before resource or supervisor waits.

Lifecycle control uses `markControlStopping` or a stop lease with purpose `control`, permitting administrator stop and restart of a reserved Steward Runtime without data qualification. Exact controls retain the selected generation, local node, Gateway process owner and durable stop operation; omitted lease purpose remains `destructive` and retains reserved-project protection. The [destructive-operation rules](2026-10-28-project-deletion-lifecycle.md) remain independent. Trusted internal lifecycle calls can omit an administrator; adapters preserve any supplied id. Current personal process privileges still follow the [owner-policy decision](2026-10-28-personal-runtime-authority.md).

Revocation rejects work not yet admitted. An approved cancellation or stop can already have completed when later authority checks fail. In particular, restart can return403 after stopping and must leave the Runtime stopped. Authorization at admission is not a continuous execution lease; later revocation still requires invalidation and stop convergence.

Terminal and plugin management recheck current administrator role and account eligibility before issuing a signed Runtime request and publishing data. Terminal inventory and ordinary plugin replies remain private until generation checks and lease cleanup finish. Plugin streams check authority before every forwarded chunk: withdrawal before the first chunk returns403, while withdrawal after authorized progress interrupts the existing stream. Desired-state, overview and target reads also recheck authority after loading. These checks do not reverse an already admitted terminal close or plugin operation; clients inspect current state before retrying.

PostgreSQL user reads report effective status from the current organization, membership and account together. An unavailable organization makes its accounts ineligible without overwriting their stored status. Restoring the organization preserves independently disabled accounts and memberships. Management response authorization consumes this effective status rather than trusting a still-active account row alone.

Bounded PostgreSQL checkout refusal returns503 with readable `error` and `code: DB_CHECKOUT_QUEUE_FULL`. Failed-request auditing records that status. Clients reload current state before deciding whether to retry; the response does not guarantee that every earlier stage of a multi-stage operation rolled back. The [checkout-admission decision](../architecture/2026-10-23-postgres-checkout-admission.md) owns capacity accounting.

## Alternatives considered

**Trust authentication until the request finishes.** Current authority can change during subsequent waits.

**Share every pending start for the same target.** Distinct initiating administrators have independently revocable authority.

**Hold administrator locks through supervision.** Resource waits and process control can be long and must not retain database connections or prevent account revocation.

**Use destructive authority for ordinary stop.** Controlling a reserved Runtime does not authorize deleting its project or files.

## Consequences

Custom instance repositories implement current administrator admission, the distinct control-stop method, and the optional `acquireStopLease` purpose. Only process-control callbacks select `control`; data-changing work preserves the default `destructive` purpose. Start claims and final personal-policy reads preserve supplied actor authority. Explicit-control service adapters forward the actor through both restart stages. Account-administration authority, device-use authorization and execution authorization remain independent requirements.

## Verification

Deterministic regressions revoke roles, accounts, memberships and organizations behind real PostgreSQL locks and lifecycle barriers. Runnable Gateway transcripts cover both stores, personal and project controls, actual LocalLauncher processes, late restart revocation, readable capacity refusal and failed-request auditing. Independent administrator starts, final owner/actor admission and retained older handles are checked separately. These checks require no model API.

The [management response transcript](../../../../gateway/tests/fixtures/administrator-rpc-withdrawal.mjs) uses real PostgreSQL identities, browser authentication, Runtime credentials and current Runtime admission before withdrawing the operator's role or organization. Another account's terminal and plugin metadata remains private, an authorized stream is interrupted before its later private data, current administrators receive normal replies, and operation references drain. The fixture owns a loopback HTTP Runtime and makes no native process-containment claim.

The [reserved Runtime transcript](../../../../gateway/tests/fixtures/central-runtime-control.mjs) exercises authenticated exact stop and restart, stale generations, administrator withdrawal after an approved stop, and retained project bytes through real PostgreSQL and owned HTTP responses. Its loopback carrier proves physical response cleanup; it does not exercise native process containment.
