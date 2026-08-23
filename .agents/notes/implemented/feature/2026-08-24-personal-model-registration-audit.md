# Agent Note: Personal Provider and model registration audit

Status: implemented

English | [中文](2026-08-24-personal-model-registration-audit.zh.md)

## Problem

Personal users can configure Provider routes and models independently, but the Gateway recorded only model calls. Administrators could not distinguish configuration activity from usage or inspect a user's registration history.

## Decision

Personal settings commits produce non-secret semantic registration events for Provider and model creation, modification, and deletion. The model-governance runtime writes these events to the existing crash-safe outbox with a `model-registration` discriminator. The authenticated intake resolves the user from the existing runtime token, deduplicates by event id, and stores the event in SQLite or PostgreSQL without API keys, credential values, profile bodies, or request content.

The administrator API and Models page expose current active Provider/model counts plus filtered history by user, Provider, model, action, and time. Registration history is permanent and read-only; it does not approve, deny, rewrite, or convert personal routes into organization routes. Usage summaries remain a separate accounting surface.

Personal Provider IDs are non-empty settings keys rather than shell identifiers. The browser derives a safe credential reference independently and adds a stable suffix for unusual IDs to avoid collisions. Adapter protocol, endpoint, credential transport, organization namespace, and model identity checks remain technical requirements.

## Alternatives considered

**Reuse model usage rows.** Rejected because a settings change is not a model call and mixing the two would corrupt usage counts and cost calculations.

**Write synchronously to the Gateway from the settings request.** Rejected because a temporary Gateway outage would make a successful local settings commit appear to fail; the existing outbox already provides durable retry and idempotency.

**Store full settings snapshots.** Rejected because snapshots increase secret exposure risk and make an audit query depend on provider-specific profile schemas; semantic identity events are sufficient for counts and history.

**Restrict personal IDs to credential-compatible lowercase names.** Rejected because credential references are an implementation detail and should not limit user-selected Provider routes.

## Consequences

Administrators can audit personal configuration activity without receiving secrets or controlling the personal configuration path. Event delivery is at-least-once and query writes are idempotent. A runtime emits a deterministic baseline for identities already present in its user settings layer, so restarts do not duplicate current counts. Personal routes with unsupported wire protocols or invalid endpoints still fail at the adapter/settings validation point, and organization-reserved routes remain outside the personal authorization path.

## Verification

Registration diff, outbox, intake, SQLite persistence, Admin API, PostgreSQL migration, and custom Provider ID tests cover the new behavior. The focused Gateway, governance, and Models settings suites pass; the Admin UI production build completes.
