# Agent Note: Model projections retain current account authority

Status: implemented

English | [中文](2026-10-29-model-policy-authority.zh.md)

## Problem

A policy request can retain an administrator role through configuration locks and projection queues. Account role changes do not advance the model catalog revision, so revision-only file and memory caches can retain an earlier authorization even after a fresh policy read. Treating a credential-store failure as malformed JSON can silently rotate the intake credential and replace policy data.

## Decision

The [PostgreSQL model service](../../../../gateway/src/postgres/model-governance-service.ts) locks the organization configuration revision before reading the current active nondeleted account and active membership. Account and membership share locks retain that role through policy construction. The SQLite service reads its current eligible account and model policy within one transaction. Request roles provide no model authorization. Withdrawn eligibility rejects before projection; [per-request execution and credential authorities](../feature/2026-08-14-gateway-model-governance-and-usage.md) remain independently required.

The [projector](../../../../gateway/src/apply-model-governance.ts) compares revision, defaults, routes and Provider settings for both its bounded memory cache and persisted file reuse. Account-only changes can therefore replace policy while preserving the catalog revision and valid subject-bound intake credential. The running [policy consumer](../feature/2026-08-14-gateway-model-governance-live-policy-reload.md) applies changed contents without a restart.

Credential validation occurs outside JSON recovery. Invalid JSON or a non-object document can be replaced from current policy. File-read and credential-store failures propagate before replacing the projection or issuing another bearer. A valid existing token remains stable across policy changes.

Bulk and direct account refresh skip disabled accounts. Admin inspection of a disabled account retains configured overrides and returns an empty effective policy with the current configuration revision; legacy adapters without a revision reader report503. A combined role/status change writes grants and confirms stop without attempting to restart the disabled owner. Re-enablement uses the normal fresh startup and projection requirements.

## Alternatives considered

**Trust the supplied account role.** A previously authorized request does not retain that role through later waits.

**Use the model revision as the complete cache key.** Account changes have independent persistence and can change effective authorization without catalog edits.

**Issue a new intake token after any old-file failure.** A failed lookup does not establish that the old credential is invalid; replacement can revoke a still valid consumer during an outage.

## Consequences

The policy JSON fields and model revision meaning stay unchanged. Custom governance adapters resolve current eligibility and role; disabled-account inspection additionally requires `configurationRevision`. Policy projection is an eventually converging cache, not an execution lease: later revocation still requires current request authorization and existing invalidation or stop handling. Files and credentials retained after a failed refresh do not prove authorization.

## Verification

Deterministic regressions place account changes behind real PostgreSQL configuration locks and queued projection admission. Store transcripts cover promotion, demotion, eager and lazy refresh, explicit denial, credential lookup failure and account withdrawal. Live Loader transcripts revoke an administrative model route after a role change without advancing the catalog revision. Real Gateway and LocalLauncher transcripts confirm combined role/disable changes stop without a replacement generation. These checks require no model API.
