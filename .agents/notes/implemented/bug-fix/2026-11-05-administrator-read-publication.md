# Agent Note: Administrator JSON reads recheck eligibility at publication

Status: implemented

English | [中文](2026-11-05-administrator-read-publication.zh.md)

## Problem

An Admin read can prepare another account's directory, model policy or usage data while its authenticated administrator loses eligibility. Checking only at HTTP entry leaves that prepared result available after withdrawal commits. Response headers such as audit totals and archive attachment names can disclose metadata even when the body is refused.

## Decision

The [request-owned responder](../../../../gateway/src/admin-response.ts) checks the authenticated account through the current user service immediately before publishing a GET, HEAD or explicitly selected POST read result. Backup configuration preview selects read qualification even though its preparatory verification may already have committed. Organization model discovery also qualifies its result after the catalog HTTP request finishes. The lookup's effective status includes organization and membership eligibility; deletion, loss of administrator role and required password changes also refuse publication. No result is cached for another response. Lookup failure returns503 with a safe diagnostic; a known eligibility loss returns403.

The [Admin router](../../../../gateway/src/admin-api.ts) and its [Runtime management delegate](../../../../gateway/src/runtime-management-api.ts) await this responder. Data-specific headers are supplied to the same operation, so withheld data also withholds audit totals and archive download names. JSON preparation uses existing services and releases their checkouts before this final lookup. Error responses selected by a read use the same qualification; the outer error handler emits only its own safe refusal.

Mutation authorization stays in the service that commits the change. The responder does not reclassify a committed mutation as failed because an administrator changes afterward. The [resource policy reader](2026-11-05-resource-policy-read-authority.md) independently retains qualification through its database read; the HTTP publication check can still refuse that result if withdrawal commits before publication. Live document streams and remote transports retain their separate revocation and cleanup rules.

## Alternatives considered

**Trust the administrator object captured at HTTP entry.** It cannot describe a role or account change committed during data preparation.

**Authorize the JSON body but publish metadata headers first.** Denied callers could still infer a count or download identity. One awaited publication owns both.

**Hold an administrator database transaction while every source prepares data.** Sources can span files, another node or multiple services. Retaining a checkout across that work can exhaust a one-connection pool and does not replace their own source authorization.

## Consequences

Admin JSON reads add one current account lookup at publication. Concurrent withdrawal can refuse a result prepared under earlier authority. No response can retract bytes already handed to the transport. The account adapter must return current effective eligibility and null for missing or deleted accounts; cached role candidates cannot implement that operation. Existing data formats and mutation results are unchanged.
