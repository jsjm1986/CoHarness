# Agent Note: Webhook admission retains administrator and endpoint authority

Status: implemented

English | [中文](2026-10-29-webhook-admission-authority.zh.md)

## Problem

HTTP authentication can precede account or membership withdrawal while a Webhook management request waits. Endpoint mutation, privileged metadata reads and manual redispatch can therefore use an obsolete administrator. Provider signature verification also captures a configuration that can be disabled, removed or replaced before a durable dispatch reservation. Parsed numbers that do not survive JSON serialization can also change stored events and later replay.

## Decision

[Endpoint management](../../../../gateway/src/postgres/webhook-endpoint-service.ts) and [receipt diagnostics](../../../../gateway/src/postgres/webhook-delivery-service.ts) retain current administrator authority with organization, account and membership share locks. The authenticated public id is an explicit service argument. Mutation and reads retain it through their transaction; redispatch checks again when creating its new reservation after configuration lookup. Earlier HTTP roles cannot authorize later database work.

A delivery reservation retains its active organization and exact endpoint revision, execution account and target before allocating intake budget or a receipt. Provider admission requires an enabled endpoint. A configuration change committed before admission rejects without a durable reservation; admitted work finishes before a conflicting endpoint change commits. Rule version mismatch returns409 for provider retry; unavailable organization or endpoint returns404. Network dispatch holds no database transaction.

Parsed provider payloads satisfy the shared lossless JSON rules before intake budget or receipt allocation. Nonfinite numbers and negative zero reject with400 rather than changing during storage. Ordinary finite JSON values retain their parsed values on replay, matching the raw GitHub adapter.

Manual administrator redispatch may use a disabled endpoint's current configuration. This explicit replay permission does not reopen public intake. Its new receipt retains both the current initiating administrator and captured endpoint version through commit. Stored receipts, aliases and body deduplication survive configuration rotation; a retry verified against the current configuration can still reuse its original receipt without another dispatch.

The [execution identity decision](../architecture/2026-09-23-webhook-execution-identity.md) continues to own execution-account qualification, purpose-bound principals, usage attribution and runtime dispatch. The [repository filter](../feature/2026-09-25-webhook-structured-repository-filter.md) retains separate matching semantics. Neither note is fully superseded.

## Alternatives considered

**Trust the HTTP administrator or verified signature until dispatch.** Authentication proves an earlier observation; database and request-body waits can outlive it.

**Check only that the endpoint still exists.** A retained row can carry another signing secret, executor, target or disabled state. The captured revision must still be current.

**Keep administrator and endpoint locks during runtime HTTP.** Remote latency would block revocation. A committed reservation records accepted work before network dispatch starts.

## Consequences

Custom Gateway services pass the server-authenticated administrator id for endpoint management, diagnostic reads and redispatch. Request JSON fields and database schemas stay unchanged. Deployments retry provider409 responses using the current configuration. A403 administrative response requires renewed administrator eligibility. Durable delivery records remain admission evidence rather than proof of Agent success.

## Verification

Authenticated Gateway replay covers six withdrawn eligibility states across eight administrative operations, current-administrator controls, provider configuration withdrawal and explicit disabled-rule replay. Real PostgreSQL tests cover rejected stale reservations, retained authority through row waits and redispatch after role or rule changes. Keyless source and emitted replays use no real provider credentials or model API.
