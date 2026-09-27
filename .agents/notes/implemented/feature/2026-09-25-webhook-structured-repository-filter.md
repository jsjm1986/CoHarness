# Agent Note: Webhook endpoints carry a structured repository filter enforced at intake

Status: implemented

English | [中文](2026-09-25-webhook-structured-repository-filter.zh.md)

## Problem

Managed webhook endpoints filtered deliveries only by event name and `payload.action`. The repository a delivery belonged to could appear in title/prompt templates but had no approved structured filter: an organization webhook signing every repository under one secret dispatched sessions for repositories the endpoint never opted into. The audit required the filter configuration to reach the execution path — rejecting non-matching repositories under the same signing secret — rather than documenting the field in a template.

## Decision

**Endpoints store a `repositories` rule alongside `events`/`actions`, evaluated inside `GatewayWebhookIntake.dispatch()` before any runtime work is reserved for the delivery.**

- Migration [042](../../../../gateway/deploy/postgres/migrations/042_webhook_repository_filter.sql) adds `repositories text[] NOT NULL DEFAULT '{}'` (cardinality ≤ 64) to `harness.webhook_endpoints`; existing rows default to the empty list, which keeps accepting every repository.
- Registration validates each entry as a structured `owner/repo` full name (`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`, ≤ 128 chars); anything else is a 400 at create/update, before it can reach intake.
- `dispatch()` compares the verified payload's `repository.full_name` against the configured entries case-insensitively, matching GitHub's case-insensitive repository naming. A configured filter fails closed: a missing, malformed, or unmatched `full_name` never dispatches.
- A filter miss records `state: 'ignored'` plus an `errorCode` naming the unmatched rule (`event-unmatched`, `action-unmatched`, `repository-unmatched`). The receipts table already stored `error_code` and the Admin delivery view already renders it, so a rejected delivery now shows which structured rule excluded it instead of an unexplained ignore.
- The Admin endpoints form edits the list as comma-separated `owner/repo` entries; the endpoints table shows the configured repositories. `repositories` rides the same revision-checked update and `dispatchConfig` path as the other rules, so administrator redispatch re-evaluates the current filter.

## Alternatives considered

**Record a `rejected` receipt for repository mismatches.** Rejected means a dispatch attempt was refused by the runtime boundary (offline runtime, inactive account, unresolved template). An organization webhook legitimately delivers events for every repository under one signature; opting out of most of them is the normal case, so a filter miss stays `ignored` — the reason code carries the diagnostic without overstating a fault.

**Generic payload-path filters (arbitrary `a.b.c` equals `x`).** Rejected: a free path/value language is a template evaluator in disguise. Three named fields keep the structured contract the approval asked for and keep validation, indexing, and UI concrete.

**Owner-prefix or wildcard entries (`acme/*`).** Rejected as speculative surface: the approved requirement is matching repositories by full name. Exact entries keep semantics obvious; an owner-wide rule can be expressed today by listing its repositories.

## Consequences

A same-secret delivery from a non-matching repository now records an `ignored` receipt with `repository-unmatched` and never reaches the bound runtime; matching is verified end-to-end in the PostgreSQL intake suite alongside case-insensitive acceptance, missing-field fail-closed, invalid-entry registration rejection, and update round-trips. Endpoints created before the migration keep their accept-all behavior until an administrator narrows them. The delivery-identity and execution-account contracts from [the webhook execution identity note](../architecture/2026-09-23-webhook-execution-identity.md) are unchanged: filtering happens after signature verification and durable reservation, before the managed dispatch call.
