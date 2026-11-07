# Agent Note: Steward read lane isolation and statement-bound approvals

Status: implemented

English | [中文](2026-11-07-steward-lane-isolation-approval-binding.zh.md)

## Problem

`StewardQueryService` checked statements out of the shared gateway pool, so a read-classified statement could still damage the deployment: `READ ONLY` blocks writes but not `set_config` (session GUCs persist on the pooled client past COMMIT), `pg_terminate_backend`/`pg_cancel_backend` (signals reach other backends), `pg_advisory_lock` (session-level locks survive COMMIT), file readers, `dblink`, or `pg_sleep`. A successful statement returned a poisoned connection to the pool every other Gateway feature shares. Separately, `verifyApproval` authorized the approval *id* only: nothing bound the grant to the statement the operator previewed, so any code in the same runtime holding the id could spend `allowed-once` on an arbitrary write inside the TTL.

## Decision

Read-classified statements now face `READ_LANE_DENY` ([steward-query.ts](../../../../gateway/src/postgres/steward-query.ts)): before any connection is touched, the statement is scrubbed of comments, string bodies, identifier quoting, and `pg_catalog.` qualifiers and rejected with `steward-statement-forbidden` when it calls a function whose effects escape `READ ONLY`. Statements also execute on a dedicated small pool (`dsh-steward-query`, wired in [index.ts](../../../../gateway/src/index.ts)) instead of the shared gateway pool, and every successful client is `DISCARD ALL`-cleared before release — three independent layers so neither a missed deny-list entry nor session residue can reach a shared connection. Approval verification now joins the claimed interaction's `call_id` to the durable `tool/call` event and requires `arguments.sql` to equal the statement being executed, so an approval spends exactly the previewed write; missing events or malformed arguments fail closed. `dryRun` EXPLAINs are unchanged because they never execute the inner statement.

## Alternatives considered

**Reset shared clients on checkin.** Scrubbing pooled connections globally would protect every borrower, but the steward channel is the only caller running adversarial SQL; isolating it keeps the shared pool's fast path and shrinks the audit surface.

**Persist the approved statement in a new column.** `conversation_interaction_responses` already records `call_id`, and the session log already stores the exact arguments — reusing durable data removes a parallel payload that could itself be attacked and needs no migration.

## Consequences

The read lane cannot mutate session state, reach sibling backends, or consume cross-statement locks; a denial is journaled like every other attempt. Approvals that predate `call_id` recording deny rather than grandfather, matching the lane's fail-closed posture. A write that differs from its preview by even whitespace denies — the runtime must present the statement it intends to run.
